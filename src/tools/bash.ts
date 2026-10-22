import { spawn } from 'node:child_process';
import { isReadOnlyCommand } from '../permissions.ts';
import { resolveShell } from '../shell.ts';
import type { ToolContext, ToolOutcome, ToolSpec } from '../types.ts';
import { optionalNumber, requiredString, truncate } from './util.ts';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
/** Keep a runaway process (yes, cat of a huge file) from exhausting memory. */
const MAX_CAPTURE_CHARS = 1_000_000;

/** Provider keys stay out of the shell: `cat`/`env` must not leak them into the transcript. */
const PROVIDER_KEY_ENV = ['VAELEN_API_KEY', 'DEEPSEEK_API_KEY', 'OPENAI_API_KEY'];

function shellEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, VAELEN_HARNESS: '1' };
  for (const name of PROVIDER_KEY_ENV) delete env[name];
  return env;
}

export const bashTool: ToolSpec = {
  name: 'bash',
  description:
    'Run a shell command in the workspace; returns stdout, stderr, exit code. Killed at the timeout.',
  readOnly: false,
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Command line to execute' },
      timeout_ms: {
        type: 'number',
        description: `Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS})`,
      },
    },
    required: ['command'],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const command = requiredString(args, 'command');
    const timeout = clamp(optionalNumber(args, 'timeout_ms') ?? DEFAULT_TIMEOUT_MS, 1000, MAX_TIMEOUT_MS);
    await ctx.permissions.approveCommand(command);
    return execute(command, ctx, timeout);
  },
};

function execute(command: string, ctx: ToolContext, timeoutMs: number): Promise<ToolOutcome> {
  return new Promise<ToolOutcome>((resolve) => {
    const shell = resolveShell();
    const child = spawn(shell.command, [...shell.args, command], {
      cwd: ctx.workspace,
      env: shellEnv(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let capped = false;
    let settled = false;
    let timedOut = false;

    const capture = (current: string, chunk: string): string => {
      if (current.length >= MAX_CAPTURE_CHARS) {
        capped = true;
        return current;
      }
      const next = current + chunk;
      if (next.length <= MAX_CAPTURE_CHARS) return next;
      capped = true;
      return next.slice(0, MAX_CAPTURE_CHARS);
    };

    const settle = (code: number | null, spawnError?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ctx.signal.removeEventListener('abort', onAbort);

      const sections: string[] = [`$ ${command}`];
      if (spawnError) sections.push(`error: ${spawnError}`);
      else sections.push(`exit: ${code ?? 'signal'}`);
      if (stdout.trim() !== '') sections.push(stdout.trimEnd());
      if (stderr.trim() !== '') sections.push(`stderr:\n${stderr.trimEnd()}`);
      if (capped) sections.push(`[output capped at ${MAX_CAPTURE_CHARS.toLocaleString()} chars]`);
      if (timedOut) sections.push(`[killed after ${timeoutMs} ms]`);
      if (ctx.signal.aborted) sections.push('[interrupted]');

      resolve({
        content: truncate(sections.join('\n')),
        isError: spawnError !== undefined || timedOut || ctx.signal.aborted || (code ?? 0) !== 0,
        mutated: !isReadOnlyCommand(command),
      });
    };

    const killTree = (): void => {
      if (child.exitCode !== null || child.killed) return;
      if (process.platform === 'win32' && child.pid) {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
          stdio: 'ignore',
          windowsHide: true,
        });
        killer.on('error', () => child.kill());
        return;
      }
      child.kill('SIGKILL');
    };

    const onAbort = (): void => {
      killTree();
      settle(null);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, timeoutMs);

    ctx.signal.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stdout = capture(stdout, text);
      ctx.onOutput?.(text);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr = capture(stderr, text);
      ctx.onOutput?.(text);
    });
    child.on('error', (error) => {
      settle(null, error.message);
    });
    child.on('close', (code) => {
      settle(code);
    });
  });
}

interface Shell {
  command: string;
  args: string[];
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}
