import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/**
 * Lifetime token accounting.
 *
 * Every model request appends one line to `~/.vaelen/usage.jsonl`, so the total
 * survives restarts, `/clear`, workspace switches, and upgrades. The ledger is
 * shared by every session on the machine (CLI and GUI alike).
 *
 * The file is a journal: delta lines plus occasional checkpoint lines that fold
 * everything before them into one record. Checkpoints keep startup reads small
 * no matter how long the ledger lives, and replacing the journal under a lock
 * means a crash can never lose or double-count a request.
 */

export interface TokenTotals {
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  requests: number;
  /** Distinct process-level sessions that have recorded usage. */
  sessions: number;
  /** Requests whose counts came from an estimate rather than the provider. */
  estimatedRequests: number;
  byModel: Record<string, number>;
  firstAt: string | null;
  lastAt: string | null;
}

export interface UsageRecord {
  promptTokens: number;
  completionTokens: number;
  totalTokens?: number;
  model: string;
  workspace?: string;
  session?: string;
  estimated?: boolean;
  requests?: number;
}

interface JournalDelta {
  v: 1;
  at: string;
  model: string;
  prompt: number;
  completion: number;
  total: number;
  requests: number;
  session?: string;
  workspace?: string;
  estimated?: boolean;
}

interface JournalCheckpoint {
  v: 1;
  at: string;
  checkpoint: TokenTotals;
  sessions: string[];
}

interface JournalState {
  totals: TokenTotals;
  sessions: Set<string>;
}

const JOURNAL_VERSION = 1;
/** Fold the journal into a checkpoint once it grows past this many bytes. */
const COMPACT_BYTES = 128 * 1024;
const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 4_000;

export function emptyTotals(): TokenTotals {
  return {
    totalTokens: 0,
    promptTokens: 0,
    completionTokens: 0,
    requests: 0,
    sessions: 0,
    estimatedRequests: 0,
    byModel: {},
    firstAt: null,
    lastAt: null,
  };
}

/** `VAELEN_USAGE_FILE` keeps tests (and portable installs) out of the real home. */
export function usageFilePath(): string {
  const override = process.env.VAELEN_USAGE_FILE;
  if (override && override.trim() !== '') return resolve(override.trim());
  return join(homedir(), '.vaelen', 'usage.jsonl');
}

function finite(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return Math.round(value);
}

function recordTotal(record: Record<string, unknown>): number {
  const total = finite(record.total);
  if (total !== undefined) return total;
  return (finite(record.prompt) ?? 0) + (finite(record.completion) ?? 0);
}

function at(record: Record<string, unknown>): string | null {
  const value = record.at;
  return typeof value === 'string' && value !== '' ? value : null;
}

function applyDelta(state: JournalState, record: Record<string, unknown>): void {
  const totals = state.totals;
  const total = recordTotal(record);
  const prompt = finite(record.prompt) ?? 0;
  const completion = finite(record.completion) ?? 0;
  const requests = Math.max(1, finite(record.requests) ?? 1);

  totals.totalTokens += total;
  totals.promptTokens += prompt;
  totals.completionTokens += completion;
  totals.requests += requests;
  if (record.estimated === true) totals.estimatedRequests += requests;

  const model = typeof record.model === 'string' ? record.model : '';
  if (model !== '') totals.byModel[model] = (totals.byModel[model] ?? 0) + total;

  const session = typeof record.session === 'string' ? record.session : '';
  if (session !== '') state.sessions.add(session);
  totals.sessions = state.sessions.size;

  const when = at(record);
  if (when) {
    if (totals.firstAt === null) totals.firstAt = when;
    totals.lastAt = when;
  }
}

function normalizeTotals(raw: unknown): TokenTotals {
  const totals = emptyTotals();
  if (typeof raw !== 'object' || raw === null) return totals;
  const record = raw as Record<string, unknown>;
  totals.totalTokens = finite(record.totalTokens) ?? 0;
  totals.promptTokens = finite(record.promptTokens) ?? 0;
  totals.completionTokens = finite(record.completionTokens) ?? 0;
  totals.requests = finite(record.requests) ?? 0;
  totals.estimatedRequests = finite(record.estimatedRequests) ?? 0;
  totals.firstAt = typeof record.firstAt === 'string' ? record.firstAt : null;
  totals.lastAt = typeof record.lastAt === 'string' ? record.lastAt : null;
  const byModel = record.byModel;
  if (typeof byModel === 'object' && byModel !== null) {
    for (const [model, value] of Object.entries(byModel as Record<string, unknown>)) {
      const tokens = finite(value);
      if (tokens !== undefined) totals.byModel[model] = tokens;
    }
  }
  return totals;
}

/** Reads the journal. Unreadable or malformed lines are skipped, never fatal. */
export function readUsageFile(path = usageFilePath()): JournalState {
  const state: JournalState = { totals: emptyTotals(), sessions: new Set<string>() };
  if (!existsSync(path)) return state;

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return state;
  }

  for (const line of raw.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) continue;
    const record = parsed as Record<string, unknown>;

    if (record.checkpoint !== undefined) {
      state.totals = normalizeTotals(record.checkpoint);
      state.sessions = new Set<string>();
      for (const session of Array.isArray(record.sessions) ? record.sessions : []) {
        if (typeof session === 'string' && session !== '') state.sessions.add(session);
      }
      state.totals.sessions = state.sessions.size;
      continue;
    }

    if (record.v !== undefined && record.v !== JOURNAL_VERSION) continue;
    applyDelta(state, record);
  }

  state.totals.sessions = state.sessions.size;
  return state;
}

/** Lifetime totals, read from disk so a second window sees the same numbers. */
export function loadUsage(path = usageFilePath()): TokenTotals {
  const state = readUsageFile(path);
  return { ...state.totals, byModel: { ...state.totals.byModel } };
}

function deltaFrom(record: UsageRecord): JournalDelta | undefined {
  const prompt = finite(record.promptTokens) ?? 0;
  const completion = finite(record.completionTokens) ?? 0;
  const total = finite(record.totalTokens) ?? prompt + completion;
  if (total <= 0 && prompt <= 0 && completion <= 0) return undefined;
  if (record.model.trim() === '') return undefined;

  const delta: JournalDelta = {
    v: JOURNAL_VERSION,
    at: new Date().toISOString(),
    prompt,
    completion,
    total,
    requests: Math.max(1, finite(record.requests) ?? 1),
    model: record.model.trim().slice(0, 120),
  };
  if (record.session) delta.session = record.session.slice(0, 64);
  if (record.workspace) delta.workspace = record.workspace.slice(0, 512);
  if (record.estimated) delta.estimated = true;
  return delta;
}

function writeCheckpoint(path: string, state: JournalState): void {
  const checkpoint: JournalCheckpoint = {
    v: JOURNAL_VERSION,
    at: new Date().toISOString(),
    checkpoint: state.totals,
    // Session ids are kept so the count stays exact after a fold; ids are ~36
    // bytes and there is one per process run, not per request.
    sessions: [...state.sessions],
  };
  // Same directory, so the rename is atomic: readers see either the old
  // journal or the checkpoint, never a half-written file.
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(checkpoint)}\n`, 'utf8');
  renameSync(temporary, path);
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function lockIsStale(lock: string): boolean {
  try {
    return Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS;
  } catch {
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

/**
 * Cross-process mutex. Node has no flock, so a lock file created with `wx` is
 * the portable option. A dead process leaves the lock behind; it is broken once
 * it goes stale (or after a long wait), so the ledger can never wedge shut.
 */
async function withLock<T>(path: string, run: () => T): Promise<T | undefined> {
  const lock = `${path}.lock`;
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    return undefined;
  }

  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  while (true) {
    try {
      const fd = openSync(lock, 'wx');
      try {
        writeSync(fd, `${process.pid} ${new Date().toISOString()}`);
      } finally {
        closeSync(fd);
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return undefined;
      // Only a lock whose owner is gone may be broken. Deleting a live one on
      // a short timer would let two processes rewrite the journal at once.
      if (lockIsStale(lock)) {
        try {
          unlinkSync(lock);
        } catch {
          // Someone else broke it first; retry after a short pause.
        }
        await delay(10 + Math.floor(Math.random() * 20));
        continue;
      }
      if (Date.now() > deadline) return undefined;
      await delay(10 + Math.floor(Math.random() * 20));
    }
  }

  try {
    return run();
  } finally {
    try {
      unlinkSync(lock);
    } catch {
      // Losing the unlock race only costs another process a short wait.
    }
  }
}

/**
 * Appends one request to the lifetime ledger and returns the new totals.
 * Failure to write is never fatal: the agent keeps working, the counter just
 * does not move.
 */
export async function recordUsage(record: UsageRecord, path = usageFilePath()): Promise<TokenTotals> {
  const delta = deltaFrom(record);
  if (!delta) return loadUsage(path);
  const line = `${JSON.stringify(delta)}\n`;

  const locked = await withLock(path, () => {
    try {
      const state = readUsageFile(path);
      applyDelta(state, { ...delta });
      if (fileSize(path) + line.length > COMPACT_BYTES) writeCheckpoint(path, state);
      else appendFileSync(path, line, 'utf8');
      return { ...state.totals, byModel: { ...state.totals.byModel } };
    } catch {
      // Disk full, permissions, a locked file: never break the turn for stats.
      return undefined;
    }
  });
  if (locked) return locked;

  // The lock (and therefore the directory) was unavailable. Fall back to a
  // plain append; a concurrent checkpoint could drop this line, but a counter
  // must never break a turn.
  try {
    appendFileSync(path, line, 'utf8');
  } catch {
    // Read-only home: totals stay put.
  }
  return loadUsage(path);
}

/** "1 request" / "12 requests", for copy that does not read like a form letter. */
export function countOf(value: number, word: string): string {
  return `${value.toLocaleString()} ${word}${value === 1 ? '' : 's'}`;
}

/** Per-model breakdown for /usage detail and review exports. */
export function topModels(totals: TokenTotals, limit = 3): string {
  const entries = Object.entries(totals.byModel).sort((a, b) => b[1] - a[1]).slice(0, limit);
  if (entries.length === 0) return 'no per-model data yet';
  return entries.map(([model, tokens]) => `${model}: ${tokens.toLocaleString()}`).join(' · ');
}

/** One-line summary used by the CLI `/usage` command. */
export function describeUsage(totals: TokenTotals): string {
  const parts = [`${totals.totalTokens.toLocaleString()} tokens`, countOf(totals.requests, 'request')];
  if (totals.sessions > 0) parts.push(countOf(totals.sessions, 'session'));
  if (totals.estimatedRequests > 0) parts.push(`${totals.estimatedRequests.toLocaleString()} estimated`);
  if (totals.firstAt) {
    const since = totals.firstAt.slice(0, 10);
    if (since !== '') parts.push(`since ${since}`);
  }
  return parts.join(' · ');
}
