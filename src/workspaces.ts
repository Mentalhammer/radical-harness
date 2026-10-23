import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/**
 * Chats are per project, so the window has to know every folder it has talked
 * about: the rail lists one project's transcripts and the id-to-file lookup has
 * to find a chat wherever it was written. This is the small registry of folders,
 * kept next to the usage ledger rather than inside a workspace.
 */
const MAX_WORKSPACES = 40;

export function workspacesFile(): string {
  const override = process.env.VAELEN_WORKSPACES_FILE;
  if (override && override.trim() !== '') return resolve(override.trim());
  return join(homedir(), '.vaelen', 'workspaces.json');
}

/** Newest first. A corrupt or missing file reads as an empty registry. */
export function loadWorkspaces(): string[] {
  const path = workspacesFile();
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { workspaces?: unknown };
    const list = Array.isArray(parsed.workspaces) ? parsed.workspaces : [];
    const seen = new Set<string>();
    const workspaces: string[] = [];
    for (const item of list) {
      if (typeof item !== 'string' || item.trim() === '') continue;
      const value = resolve(item);
      const key = value.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      workspaces.push(value);
      if (workspaces.length >= MAX_WORKSPACES) break;
    }
    return workspaces;
  } catch {
    return [];
  }
}

function save(workspaces: string[]): void {
  const path = workspacesFile();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ workspaces }, null, 2)}\n`, { mode: 0o600 });
}

/** Moves a folder to the front of the registry, keeping at most 40 entries. */
export function recordWorkspace(path: string): string[] {
  const value = resolve(path);
  const key = value.toLowerCase();
  const list = [value, ...loadWorkspaces().filter((item) => item.toLowerCase() !== key)].slice(
    0,
    MAX_WORKSPACES,
  );
  save(list);
  return list;
}

/** Every transcript folder the window should look in. */
export function sessionDirFor(workspace: string): string {
  return join(workspace, '.vaelen', 'sessions');
}

export function knownWorkspaces(fallback: string, extra: Iterable<string> = []): string[] {
  const seen = new Set<string>();
  const list: string[] = [];
  const add = (value: string): void => {
    if (value.trim() === '') return;
    const resolved = resolve(value);
    const key = resolved.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    list.push(resolved);
  };
  for (const value of extra) add(value);
  add(fallback);
  for (const value of loadWorkspaces()) add(value);
  return list;
}
