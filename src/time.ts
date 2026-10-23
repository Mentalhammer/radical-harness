import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/**
 * Lifetime working-time ledger.
 * Mirrors usage.jsonl: one delta line per finished turn, periodic checkpoints.
 * "Working" = wall-clock a turn was busy (streaming + tools + verify).
 */
export interface TimeTotals {
  totalMs: number;
  turns: number;
  sessions: number;
  firstAt: string | null;
  lastAt: string | null;
}

export function emptyTime(): TimeTotals {
  return { totalMs: 0, turns: 0, sessions: 0, firstAt: null, lastAt: null };
}

export function timeFilePath(): string {
  const override = process.env.VAELEN_TIME_FILE;
  if (override && override.trim() !== '') return resolve(override.trim());
  return join(homedir(), '.vaelen', 'time.jsonl');
}

function finiteMs(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return Math.floor(value);
}

export function formatDuration(ms: number): string {
  // A missing duration used to print "NaNs": NaN survives Math.max/Min and lands
  // in the seconds slot. Only a finite, positive value may reach the formatter.
  const totalSec = Math.floor((Number.isFinite(ms) && ms > 0 ? ms : 0) / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

export function describeTime(totals: TimeTotals): string {
  const parts = [formatDuration(totals.totalMs), `${totals.turns.toLocaleString()} turn${totals.turns === 1 ? '' : 's'}`];
  if (totals.sessions > 0) parts.push(`${totals.sessions.toLocaleString()} session${totals.sessions === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

interface TimeDelta { v: 1; at: string; ms: number; turns: number; session?: string }
interface TimeCheckpoint { v: 1; at: string; checkpoint: TimeTotals; sessions: string[] }
interface TimeState { totals: TimeTotals; sessions: Set<string> }

const JOURNAL_VERSION = 1;
const COMPACT_BYTES = 64 * 1024;
const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 4_000;

function normalize(raw: unknown): TimeTotals {
  const out = emptyTime();
  if (typeof raw !== 'object' || raw === null) return out;
  const r = raw as Record<string, unknown>;
  out.totalMs = finiteMs(r.totalMs) ?? 0;
  out.turns = finiteMs(r.turns) ?? 0;
  out.firstAt = typeof r.firstAt === 'string' ? r.firstAt : null;
  out.lastAt = typeof r.lastAt === 'string' ? r.lastAt : null;
  return out;
}

function readState(path = timeFilePath()): TimeState {
  const state: TimeState = { totals: emptyTime(), sessions: new Set<string>() };
  if (!existsSync(path)) return state;
  let raw: string;
  try { raw = readFileSync(path, 'utf8'); } catch { return state; }
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { continue; }
    if (typeof parsed !== 'object' || parsed === null) continue;
    const rec = parsed as Record<string, unknown>;
    if (rec.checkpoint !== undefined) {
      state.totals = normalize(rec.checkpoint);
      state.sessions = new Set<string>();
      for (const s of Array.isArray(rec.sessions) ? rec.sessions : []) {
        if (typeof s === 'string' && s !== '') state.sessions.add(s);
      }
      state.totals.sessions = state.sessions.size;
      continue;
    }
    if (rec.v !== undefined && rec.v !== JOURNAL_VERSION) continue;
    const ms = finiteMs(rec.ms) ?? 0;
    const turns = Math.max(1, finiteMs(rec.turns) ?? 1);
    if (ms <= 0) continue;
    state.totals.totalMs += ms;
    state.totals.turns += turns;
    const session = typeof rec.session === 'string' ? rec.session : '';
    if (session !== '') state.sessions.add(session);
    state.totals.sessions = state.sessions.size;
    const at = typeof rec.at === 'string' ? rec.at : null;
    if (at) {
      if (!state.totals.firstAt) state.totals.firstAt = at;
      state.totals.lastAt = at;
    }
  }
  state.totals.sessions = state.sessions.size;
  return state;
}

export function loadTime(path = timeFilePath()): TimeTotals {
  const s = readState(path);
  return { ...s.totals };
}

function fileSize(path: string): number {
  try { return statSync(path).size; } catch { return 0; }
}
function lockIsStale(lock: string): boolean {
  try { return Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS; } catch { return false; }
}
function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
async function withLock<T>(path: string, run: () => T): Promise<T | undefined> {
  const lock = `${path}.lock`;
  try { mkdirSync(dirname(path), { recursive: true }); } catch { return undefined; }
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (true) {
    try {
      const fd = openSync(lock, 'wx');
      try { writeSync(fd, `${process.pid} ${new Date().toISOString()}`); } finally { closeSync(fd); }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return undefined;
      if (lockIsStale(lock)) {
        try { unlinkSync(lock); } catch { /* raced */ }
        await delay(10 + Math.floor(Math.random() * 20));
        continue;
      }
      if (Date.now() > deadline) return undefined;
      await delay(10 + Math.floor(Math.random() * 20));
    }
  }
  try { return run(); } finally {
    try { unlinkSync(lock); } catch { /* unlock race */ }
  }
}

function writeCheckpoint(path: string, state: TimeState): void {
  const cp: TimeCheckpoint = { v: JOURNAL_VERSION, at: new Date().toISOString(), checkpoint: state.totals, sessions: [...state.sessions] };
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(cp)}\n`, 'utf8');
  renameSync(tmp, path);
}

export async function recordTime(ms: number, session?: string, path = timeFilePath()): Promise<TimeTotals> {
  const rounded = Math.floor(ms);
  if (!Number.isFinite(rounded) || rounded <= 0) return loadTime(path);
  const delta: TimeDelta = { v: JOURNAL_VERSION, at: new Date().toISOString(), ms: rounded, turns: 1, session: session?.slice(0, 64) };
  const line = `${JSON.stringify(delta)}\n`;
  const locked = await withLock(path, () => {
    try {
      const state = readState(path);
      state.totals.totalMs += rounded;
      state.totals.turns += 1;
      if (delta.session) state.sessions.add(delta.session);
      state.totals.sessions = state.sessions.size;
      state.totals.lastAt = delta.at;
      if (!state.totals.firstAt) state.totals.firstAt = delta.at;
      if (fileSize(path) + line.length > COMPACT_BYTES) writeCheckpoint(path, state);
      else appendFileSync(path, line, 'utf8');
      return { ...state.totals };
    } catch { return undefined; }
  });
  if (locked) return locked;
  try { appendFileSync(path, line, 'utf8'); } catch { /* best-effort */ }
  return loadTime(path);
}
