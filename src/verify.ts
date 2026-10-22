import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config.ts';
import { runShell } from './shell.ts';

export interface VerificationCheck {
  name: string;
  command: string;
  source: string;
}

export interface CheckResult extends VerificationCheck {
  ok: boolean;
  code: number | null;
  timedOut: boolean;
  output: string;
  durationMs: number;
}

export interface VerificationResult {
  ok: boolean;
  results: CheckResult[];
  /** Combined, truncated report that can go straight back to the model. */
  report: string;
}

const MAX_REPORT_CHARS = 12_000;
const MAX_CHECKS = 3;

/**
 * Picks the project's own fast checks. Explicit commands win; otherwise the
 * common typecheck/lint scripts are used, and a project with only tests gets
 * its test script rather than nothing.
 */
export function discoverChecks(workspace: string, config: Config): VerificationCheck[] {
  if (!config.verify) return [];
  if (config.verifyCommands.length > 0) {
    return config.verifyCommands.slice(0, MAX_CHECKS).map((command, index) => ({
      name: `custom ${index + 1}`,
      command,
      source: 'config',
    }));
  }

  const checks: VerificationCheck[] = [];
  const packageJson = readJson(join(workspace, 'package.json'));
  if (packageJson) {
    const scripts = packageJson.scripts;
    if (scripts && typeof scripts === 'object') {
      const entries = scripts as Record<string, unknown>;
      const preferred = ['typecheck', 'lint', 'check'];
      for (const name of preferred) {
        if (checks.length >= MAX_CHECKS) break;
        if (typeof entries[name] === 'string' && entries[name] !== '') {
          checks.push({
            name,
            command: `npm run ${name}`,
            source: 'package.json',
          });
        }
      }
      if (checks.length === 0 && typeof entries.test === 'string' && entries.test !== '') {
        checks.push({ name: 'test', command: 'npm test', source: 'package.json' });
      }
    }
  }

  if (checks.length === 0 && existsSync(join(workspace, 'tsconfig.json'))) {
    const localTsc = join(workspace, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');
    if (existsSync(localTsc)) {
      checks.push({ name: 'tsc', command: 'npx --no-install tsc --noEmit', source: 'tsconfig.json' });
    }
  }
  if (checks.length === 0 && existsSync(join(workspace, 'Cargo.toml'))) {
    checks.push({ name: 'cargo', command: 'cargo check --quiet', source: 'Cargo.toml' });
  }
  if (checks.length === 0 && existsSync(join(workspace, 'go.mod'))) {
    checks.push({ name: 'go', command: 'go build ./...', source: 'go.mod' });
  }

  return checks.slice(0, MAX_CHECKS);
}

/** Runs checks in order and stops at the first failure. */
export async function runChecks(
  checks: VerificationCheck[],
  workspace: string,
  config: Config,
  signal: AbortSignal,
  onOutput?: (chunk: string) => void,
): Promise<VerificationResult> {
  const results: CheckResult[] = [];

  for (const check of checks) {
    if (signal.aborted) break;
    const started = Date.now();
    const result = await runShell(check.command, {
      cwd: workspace,
      timeoutMs: config.verifyTimeoutMs,
      signal,
      onOutput,
      maxChars: 200_000,
    });
    const combined = [result.stdout, result.stderr].filter((part) => part.trim() !== '').join('\n').trimEnd();
    const ok = !result.timedOut && result.code === 0;
    results.push({
      ...check,
      ok,
      code: result.code,
      timedOut: result.timedOut,
      output: combined,
      durationMs: Date.now() - started,
    });
    if (!ok) break;
  }

  const ok = results.length > 0 && results.every((result) => result.ok);
  return { ok, results, report: formatReport(results) };
}

function formatReport(results: CheckResult[]): string {
  const sections: string[] = [];
  for (const result of results) {
    const seconds = (result.durationMs / 1000).toFixed(1);
    const status = result.timedOut
      ? `timed out after ${seconds}s`
      : `exit: ${result.code ?? 'signal'} in ${seconds}s`;
    const body = result.output === '' ? '(no output)' : result.output;
    sections.push(`$ ${result.command}\n${status}\n${body}`);
  }
  const report = sections.join('\n\n');
  if (report.length <= MAX_REPORT_CHARS) return report;
  return `${report.slice(0, MAX_REPORT_CHARS)}\n… [verification output truncated]`;
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
