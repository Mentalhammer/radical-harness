import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface Shell {
  command: string;
  args: string[];
}

/** Git Bash is the shell the agent assumes on Windows (the README says so). */
export function resolveShell(): Shell {
  if (process.platform === 'win32') {
    const candidates = [
      join(process.env.ProgramFiles ?? 'C:/Program Files', 'Git', 'bin', 'bash.exe'),
      'C:/Program Files/Git/bin/bash.exe',
      'C:/Program Files (x86)/Git/bin/bash.exe',
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) return { command: candidate, args: ['-lc'] };
    }
    return { command: 'bash', args: ['-lc'] };
  }
  return { command: existsSync('/bin/bash') ? '/bin/bash' : 'sh', args: ['-lc'] };
}

export interface ShellResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error?: string;
}

export interface ShellOptions {
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  onOutput?: (chunk: string) => void;
  maxChars?: number;
  /** Written to the command's stdin, then closed. */
  input?: string;
}

/**
 * Runs one command line for internal checks (verification, hooks). The bash
 * tool has its own streaming implementation; this one is deliberately small.
 */
export function runShell(command: string, options: ShellOptions): Promise<ShellResult> {
  const max = options.maxChars ?? 200_000;
  return new Promise<ShellResult>((resolve) => {
    const shell = resolveShell();
    const child = spawn(shell.command, [...shell.args, command], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const capture = (current: string, chunk: string): string =>
      current.length >= max ? current : (current + chunk).slice(0, max);

    const finish = (code: number | null, error?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve({ code, stdout, stderr, timedOut, error });
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
      finish(null);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, options.timeoutMs);

    options.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stdout = capture(stdout, text);
      options.onOutput?.(text);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr = capture(stderr, text);
      options.onOutput?.(text);
    });
    child.on('error', (error) => finish(null, error.message));
    child.on('close', (code) => finish(code));
  });
}
