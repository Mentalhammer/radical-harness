import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runShell } from './shell.ts';
import { redactValue } from './secrets.ts';

export interface AuditEvent {
  at?: string;
  event: string;
  [key: string]: unknown;
}

/**
 * A local, append-only record of what the agent did. Transcripts say what the
 * model said; this says which tool ran, with which arguments, and whether it
 * succeeded — the part a reviewer needs after the fact.
 */
export class AuditLog {
  readonly path: string;
  readonly #session: string;
  #broken = false;

  constructor(workspace: string, session: string, override?: string) {
    this.path = override && override.trim() !== '' ? override.trim() : join(workspace, '.vaelen', 'audit.jsonl');
    this.#session = session;
  }

  record(event: AuditEvent): void {
    if (this.#broken) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      // Tool arguments are recorded verbatim, so scrub them here as well: the audit
      // log is meant to be shareable with a reviewer.
      const line = JSON.stringify(redactValue({ at: new Date().toISOString(), session: this.#session, ...event }));
      appendFileSync(this.path, `${line}\n`, 'utf8');
    } catch {
      // Auditing must never end a turn.
      this.#broken = true;
    }
  }

  /** Newest last, for `/audit` and the HTTP endpoint. */
  tail(limit = 20): AuditEvent[] {
    if (!existsSync(this.path)) return [];
    try {
      // Audit logs grow without bound; never slurp a multi-MB file just for the last 20 lines.
      const TAIL_BYTES = 512_000;
      let text: string;
      try {
        const size = statSync(this.path).size;
        if (size > TAIL_BYTES) {
          const fd = openSync(this.path, 'r');
          try {
            const buf = Buffer.alloc(TAIL_BYTES);
            readSync(fd, buf, 0, TAIL_BYTES, size - TAIL_BYTES);
            text = buf.toString('utf8');
            // Drop the first partial line — it belongs to the chunk before.
            const cut = text.indexOf('\n');
            if (cut >= 0) text = text.slice(cut + 1);
          } finally {
            closeSync(fd);
          }
        } else {
          text = readFileSync(this.path, 'utf8');
        }
      } catch {
        text = readFileSync(this.path, 'utf8');
      }
      const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
      return lines.slice(-Math.max(1, limit)).map((line) => {
        try {
          return JSON.parse(line) as AuditEvent;
        } catch {
          return { event: 'unreadable', raw: line.slice(0, 200) };
        }
      });
    } catch {
      return [];
    }
  }
}

export function auditPathFor(workspace: string): string {
  const override = process.env.VAELEN_AUDIT_FILE;
  return override && override.trim() !== '' ? override.trim() : join(workspace, '.vaelen', 'audit.jsonl');
}

export interface HookConfig {
  preTool?: string;
  postTool?: string;
  timeoutMs: number;
}

/**
 * Hooks are ordinary shell commands that receive one JSON object on stdin.
 * A preTool hook that exits non-zero blocks the call: that is the seam for a
 * team's own policy (no writes on Fridays, no network tools, and so on).
 */
export function loadHooks(workspace: string): HookConfig {
  const path = process.env.VAELEN_HOOKS && process.env.VAELEN_HOOKS.trim() !== ''
    ? process.env.VAELEN_HOOKS.trim()
    : join(workspace, '.vaelen', 'hooks.json');
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return { timeoutMs: 10_000 };
  }
  const timeout = Number(parsed.timeoutMs);
  return {
    preTool: typeof parsed.preTool === 'string' && parsed.preTool.trim() !== '' ? parsed.preTool : undefined,
    postTool: typeof parsed.postTool === 'string' && parsed.postTool.trim() !== '' ? parsed.postTool : undefined,
    timeoutMs: Number.isFinite(timeout) && timeout >= 100 ? Math.min(timeout, 60_000) : 10_000,
  };
}

export interface HookOutcome {
  ok: boolean;
  output: string;
}

export async function runHook(
  command: string,
  payload: Record<string, unknown>,
  workspace: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<HookOutcome> {
  const result = await runShell(command, {
    cwd: workspace,
    timeoutMs,
    signal,
    input: JSON.stringify(payload),
    maxChars: 20_000,
    env: { ...process.env, VAELEN_HOOK: '1' },
  });
  const output = [result.stdout, result.stderr].filter((part) => part.trim() !== '').join('\n').trim();
  return { ok: !result.timedOut && result.code === 0, output };
}

export function auditSearch(events: AuditEvent[], query: string): AuditEvent[] {
  const q = query.trim().toLowerCase();
  if (q === '') return events;
  const terms = q.split(/\s+/);
  return events.filter((entry) => {
    const hay = `${String(entry.tool ?? '')} ${String(entry.event ?? '')} ${JSON.stringify(entry.args ?? '').slice(0, 500)}`.toLowerCase();
    return terms.every((term) => hay.includes(term));
  });
}

export function auditPreview(value: unknown, limit = 1_500): string {
  let text: string;
  try {
    text = typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));
  } catch {
    text = String(value);
  }
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
