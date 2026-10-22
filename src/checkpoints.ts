import { randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

/**
 * Edits are snapshotted before they happen, one folder per agent run. Files are
 * copied, not diffed: restoring must be byte-for-byte, including CRLF endings
 * and files that were deleted or created.
 */
const CHECKPOINT_ROOT = join('.vaelen', 'checkpoints');
const KEEP = 100;

export interface CheckpointEntry {
  /** Workspace-relative POSIX path. */
  path: string;
  existed: boolean;
  /** Backup file name inside the checkpoint folder, when the file existed. */
  backup?: string;
}

export interface CheckpointSummary {
  id: string;
  at: string;
  label: string;
  files: number;
  partial: boolean;
}

interface Manifest {
  id: string;
  at: string;
  label: string;
  partial: boolean;
  entries: CheckpointEntry[];
}

export function checkpointsDirectory(workspace: string): string {
  return join(workspace, CHECKPOINT_ROOT);
}

function checkpointDirectory(workspace: string, id: string): string | null {
  if (!/^[A-Za-z0-9._-]+$/.test(id) || id.startsWith('.') || id.includes('..')) return null;
  return join(checkpointsDirectory(workspace), id);
}

function inside(workspace: string, target: string): boolean {
  const rel = relative(resolve(workspace), resolve(target));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** One run's worth of undoable changes. */
export class CheckpointBatch {
  readonly id: string;
  #workspace: string;
  #label: string;
  #directory: string;
  #entries = new Map<string, CheckpointEntry>();
  #finished = false;
  #broken = false;

  constructor(workspace: string, label = 'agent turn') {
    this.#workspace = resolve(workspace);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    this.id = `${stamp}-${randomUUID().slice(0, 8)}`;
    this.#label = label;
    this.#directory = join(checkpointsDirectory(this.#workspace), this.id);
  }

  get size(): number {
    return this.#entries.size;
  }

  /** Copies the current file aside before a tool changes it. Never throws. */
  snapshot(absolute: string): void {
    if (this.#finished || this.#broken) return;
    const target = resolve(absolute);
    if (!inside(this.#workspace, target)) return;
    const rel = relative(this.#workspace, target).replace(/\\/g, '/');
    if (this.#entries.has(rel)) return;

    try {
      mkdirSync(this.#directory, { recursive: true });
      const info = statSync(target, { throwIfNoEntry: false });
      if (info?.isFile()) {
        const backup = `${this.#entries.size}.bak`;
        copyFileSync(target, join(this.#directory, backup));
        this.#entries.set(rel, { path: rel, existed: true, backup });
      } else {
        this.#entries.set(rel, { path: rel, existed: false });
      }
      // Write after every snapshot: a crash mid-turn should still leave an
      // undoable checkpoint for the edits that already landed.
      this.#flush(true);
    } catch {
      // Undo is best-effort; a full disk must not stop the edit itself.
      this.#broken = true;
    }
  }

  /** Seals the batch. Returns the checkpoint id, or null when nothing changed. */
  finish(): string | null {
    if (this.#finished) return this.#entries.size > 0 ? this.id : null;
    this.#finished = true;
    if (this.#entries.size === 0) {
      // An empty folder would show up as a useless undo step.
      try {
        rmSync(this.#directory, { recursive: true, force: true });
      } catch {
        // Nothing to clean up.
      }
      return null;
    }
    try {
      this.#flush(false);
      prune(this.#workspace);
    } catch {
      // The manifest written on the last snapshot is still usable.
    }
    return this.id;
  }

  #flush(partial: boolean): void {
    const manifest: Manifest = {
      id: this.id,
      at: new Date().toISOString(),
      label: this.#label,
      partial,
      entries: [...this.#entries.values()],
    };
    const file = join(this.#directory, 'manifest.json');
    const temporary = `${file}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    renameSync(temporary, file);
  }
}

/** Newest first. Reads only folders that still hold a manifest. */
export function listCheckpoints(workspace: string): CheckpointSummary[] {
  let names: string[];
  try {
    names = readdirSync(checkpointsDirectory(workspace));
  } catch {
    return [];
  }
  const summaries: CheckpointSummary[] = [];
  for (const name of names) {
    const manifest = readManifest(workspace, name);
    if (!manifest) continue;
    summaries.push({
      id: manifest.id,
      at: manifest.at,
      label: manifest.label,
      files: manifest.entries.length,
      partial: manifest.partial,
    });
  }
  return summaries.sort((a, b) => b.id.localeCompare(a.id));
}

/**
 * Restores the newest checkpoint (or an explicit id) and removes it, so calling
 * undo again walks further back through history.
 */
export function restoreLatest(
  workspace: string,
  id?: string,
): { id: string; files: string[]; partial: boolean } | null {
  const root = resolve(workspace);
  const candidate = id ?? listCheckpoints(root)[0]?.id;
  if (!candidate) return null;

  const directory = checkpointDirectory(root, candidate);
  if (!directory) return null;
  const manifest = readManifest(root, candidate);
  if (!manifest) return null;

  const restored: string[] = [];
  for (const entry of manifest.entries) {
    const target = resolve(root, entry.path);
    // The manifest is local data, but a hand-edited one must not escape the
    // workspace or touch a system path.
    if (!inside(root, target) || relative(root, target) === '') continue;
    try {
      if (entry.existed && entry.backup) {
        const backup = join(directory, entry.backup);
        if (!existsSync(backup)) continue;
        mkdirSync(resolve(target, '..'), { recursive: true });
        copyFileSync(backup, target);
        restored.push(entry.path);
      } else if (!entry.existed) {
        if (existsSync(target)) {
          unlinkSync(target);
          restored.push(entry.path);
        }
      }
    } catch {
      // One unwritable file should not stop the rest of the undo.
    }
  }

  try {
    rmSync(directory, { recursive: true, force: true });
  } catch {
    // The files are already back; a stale folder is harmless.
  }

  return { id: manifest.id, files: restored, partial: manifest.partial };
}

/** Human summary for /checkpoints and review UIs. */
export function describeCheckpoint(summary: CheckpointSummary): string {
  return `${summary.id} · ${summary.files} file(s) · ${summary.label}${summary.partial ? ' · partial' : ''} · ${summary.at}`;
}

/** Keeps the folder from growing without bound across months of work. */
function prune(workspace: string): void {
  const summaries = listCheckpoints(workspace);
  for (const older of summaries.slice(KEEP)) {
    const directory = checkpointDirectory(workspace, older.id);
    if (!directory) continue;
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // Another process may be using it; try again next turn.
    }
  }
}

function readManifest(workspace: string, id: string): Manifest | null {
  const directory = checkpointDirectory(workspace, id);
  if (!directory) return null;
  try {
    const parsed = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')) as Manifest;
    if (!Array.isArray(parsed.entries) || typeof parsed.id !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}
