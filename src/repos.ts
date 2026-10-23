import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** A repository the window can work in, identified the way GitHub does. */
export interface RepoRef {
  owner: string;
  name: string;
}

export interface RepoHistoryEntry extends RepoRef {
  path: string;
  openedAt: string;
}

export interface GhStatus {
  installed: boolean;
  authenticated: boolean;
  user: string;
}

export interface RemoteRepo extends RepoRef {
  visibility: string;
  updatedAt: string;
}

export interface RemoteRepoList {
  ok: boolean;
  repos: RemoteRepo[];
  error?: string;
  /** More repositories exist than were returned (the list is capped). */
  truncated?: boolean;
}

export interface CloneResult {
  ok: boolean;
  path: string;
  method: 'local' | 'gh' | 'git';
  error?: string;
}

const NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98})$/;
const MAX_HISTORY = 30;
const CLONE_TIMEOUT_MS = 300_000;
/** Rendering thousands of rows helps nobody; the newest 500 are kept. */
const MAX_REMOTE_REPOS = 500;

/** Where clones live; overridable so tests never touch the real folder. */
export function reposDirectory(): string {
  const override = process.env.VAELEN_REPOS_DIR;
  if (override && override.trim() !== '') return override.trim();
  return join(homedir(), '.vaelen', 'repos');
}

/** The history list is a separate small file next to the usage ledger. */
export function historyFile(): string {
  const override = process.env.VAELEN_REPOS_FILE;
  if (override && override.trim() !== '') return override.trim();
  return join(homedir(), '.vaelen', 'repos.json');
}

/**
 * Accepts `owner/name`, a GitHub URL, or an SSH remote. Anything that could
 * escape the clone folder or look like a git option is rejected.
 */
export function parseRepo(input: unknown): RepoRef | null {
  if (typeof input !== 'string') return null;
  let text = input.trim();
  if (text === '') return null;

  text = text.replace(/^git@github\.com:/i, '').replace(/^https?:\/\/(?:www\.)?github\.com\//i, '');
  text = text.replace(/\/+$/, '').replace(/\.git$/i, '');
  const parts = text.split('/').filter((part) => part !== '');
  if (parts.length !== 2) return null;

  const [owner, name] = parts as [string, string];
  if (!NAME.test(owner) || !NAME.test(name)) return null;
  if (owner.startsWith('-') || name.startsWith('-')) return null;
  return { owner, name };
}

export function repoLabel(repo: RepoRef): string {
  return `${repo.owner}/${repo.name}`;
}

export function repoPath(repo: RepoRef): string {
  return join(reposDirectory(), repo.owner, repo.name);
}

function sameRepo(a: RepoRef, b: RepoRef): boolean {
  return a.owner.toLowerCase() === b.owner.toLowerCase() && a.name.toLowerCase() === b.name.toLowerCase();
}

/** Newest first; a corrupt file is treated as an empty history. */
export function loadHistory(): RepoHistoryEntry[] {
  const path = historyFile();
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { repos?: unknown };
    const list = Array.isArray(parsed.repos) ? parsed.repos : [];
    const seen = new Set<string>();
    const history: RepoHistoryEntry[] = [];
    for (const item of list) {
      if (typeof item !== 'object' || item === null) continue;
      const record = item as Record<string, unknown>;
      const repo = parseRepo(`${record.owner}/${record.name}`);
      if (!repo) continue;
      const label = repoLabel(repo).toLowerCase();
      if (seen.has(label)) continue;
      seen.add(label);
      history.push({
        ...repo,
        path: typeof record.path === 'string' && record.path !== '' ? record.path : repoPath(repo),
        openedAt: typeof record.openedAt === 'string' ? record.openedAt : new Date(0).toISOString(),
      });
      if (history.length >= MAX_HISTORY) break;
    }
    return history;
  } catch {
    return [];
  }
}

function saveHistory(history: RepoHistoryEntry[]): void {
  const path = historyFile();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ repos: history }, null, 2)}\n`, { mode: 0o600 });
}

/** Moves a repo to the front of the history, keeping at most 30 entries. */
export function recordRepo(repo: RepoRef, path: string): RepoHistoryEntry[] {
  const entry: RepoHistoryEntry = { ...repo, path, openedAt: new Date().toISOString() };
  const history = [entry, ...loadHistory().filter((item) => !sameRepo(item, repo))].slice(0, MAX_HISTORY);
  saveHistory(history);
  return history;
}

export function forgetRepo(repo: RepoRef): RepoHistoryEntry[] {
  const history = loadHistory().filter((item) => !sameRepo(item, repo));
  saveHistory(history);
  return history;
}

function run(file: string, args: string[], timeout = 20_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, windowsHide: true, maxBuffer: 4_000_000 }, (error, stdout, stderr) => {
      const code = error && typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : error ? 1 : 0;
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

let cachedStatus: { at: number; value: GhStatus } | undefined;

/** `gh` gives private-repo access for free when the user has signed in. */
export async function ghStatus(): Promise<GhStatus> {
  if (cachedStatus && Date.now() - cachedStatus.at < 30_000) return cachedStatus.value;

  const probe = await run('gh', ['--version'], 8_000);
  if (probe.code !== 0) {
    cachedStatus = { at: Date.now(), value: { installed: false, authenticated: false, user: '' } };
    return cachedStatus.value;
  }

  const auth = await run('gh', ['auth', 'status'], 8_000);
  const user = await run('gh', ['api', 'user', '--jq', '.login'], 10_000);
  const value: GhStatus = {
    installed: true,
    authenticated: auth.code === 0,
    user: auth.code === 0 && user.code === 0 ? user.stdout.trim() : '',
  };
  cachedStatus = { at: Date.now(), value };
  return value;
}

/** The signed-in user's repositories, for the "my repositories" picker. */
/**
 * The gh call behind the repository picker.
 *
 * `gh repo list` only covers repositories the account *owns* and stops at
 * `--limit` (30 by default, 50 here), so a collaborator's repository or an
 * organisation's repository never appeared. The REST endpoint takes every
 * affiliation and `--paginate` walks all pages, so nothing is silently cut off.
 */
export function reposListArgs(): string[] {
  return [
    'api',
    '--paginate',
    'user/repos?per_page=100&affiliation=owner,collaborator,organization_member&sort=updated',
    '--jq',
    '.[] | {nameWithOwner: .full_name, visibility: .visibility, updatedAt: .updated_at}',
  ];
}

/** Internal repositories are not public either, so both count as private here. */
function normalizeVisibility(value: unknown): 'public' | 'private' {
  const text = typeof value === 'string' ? value.toLowerCase() : '';
  return text === 'private' || text === 'internal' ? 'private' : 'public';
}

/**
 * Parses the JSONL that `gh api --jq` emits. Duplicates are dropped (pagination
 * can overlap when repositories are updated mid-walk) and the result is newest
 * first, which is the order the picker shows.
 */
export function parseRepoApiList(stdout: string): RemoteRepo[] {
  const seen = new Set<string>();
  const repos: RemoteRepo[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    let item: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== 'object' || parsed === null) continue;
      item = parsed as Record<string, unknown>;
    } catch {
      continue; // a torn line must not hide the rest of the list
    }
    const repo = parseRepo(item.nameWithOwner);
    if (!repo) continue;
    const key = `${repo.owner.toLowerCase()}/${repo.name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    repos.push({
      ...repo,
      visibility: normalizeVisibility(item.visibility),
      updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : '',
    });
  }
  return repos.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** The older `gh repo list --json` shape, used when the API call is unavailable. */
function parseRepoListJson(stdout: string): RemoteRepo[] | null {
  try {
    const parsed = JSON.parse(stdout) as Array<Record<string, unknown>>;
    const repos: RemoteRepo[] = [];
    for (const item of parsed) {
      const repo = parseRepo(item.nameWithOwner);
      if (!repo) continue;
      repos.push({
        ...repo,
        visibility: normalizeVisibility(item.visibility),
        updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : '',
      });
    }
    return repos;
  } catch {
    return null;
  }
}

export async function listOwnRepos(): Promise<RemoteRepoList> {
  const status = await ghStatus();
  if (!status.installed) return { ok: false, repos: [], error: 'GitHub CLI (gh) is not installed' };
  if (!status.authenticated) return { ok: false, repos: [], error: 'GitHub CLI is not signed in — run: gh auth login' };

  const listed = await run('gh', reposListArgs(), 60_000);
  let repos = listed.code === 0 ? parseRepoApiList(listed.stdout) : [];

  if (listed.code !== 0 || repos.length === 0) {
    // An older gh, or a token without the user scope: fall back to the plain
    // list, which at least covers owned repositories instead of showing nothing.
    const fallback = await run(
      'gh',
      ['repo', 'list', '--limit', '1000', '--json', 'nameWithOwner,visibility,updatedAt'],
      30_000,
    );
    if (fallback.code !== 0) {
      return { ok: false, repos: [], error: (listed.stderr || fallback.stderr).trim() || 'Could not list repositories' };
    }
    const parsed = parseRepoListJson(fallback.stdout);
    if (parsed === null) return { ok: false, repos: [], error: 'GitHub returned an unreadable repository list' };
    repos = parsed;
  }

  const truncated = repos.length > MAX_REMOTE_REPOS;
  return { ok: true, repos: truncated ? repos.slice(0, MAX_REMOTE_REPOS) : repos, truncated };
}

/**
 * Reuses an existing clone, otherwise clones shallowly with gh (private repos)
 * or plain git (public). Never prompts on the terminal: a missing credential
 * fails fast instead of hanging a request.
 */
export async function openRepo(repo: RepoRef): Promise<CloneResult> {
  const path = repoPath(repo);
  if (existsSync(join(path, '.git'))) return { ok: true, path, method: 'local' };
  if (existsSync(path)) return { ok: false, path, method: 'local', error: `${path} exists but is not a git repository` };

  mkdirSync(dirname(path), { recursive: true });
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' };
  const status = await ghStatus();
  const attempts: Array<{ method: 'gh' | 'git'; file: string; args: string[] }> = [];

  if (status.authenticated) {
    attempts.push({ method: 'gh', file: 'gh', args: ['repo', 'clone', repoLabel(repo), path, '--', '--depth', '1'] });
  }
  attempts.push({ method: 'git', file: 'git', args: ['clone', '--depth', '1', '--', `https://github.com/${repoLabel(repo)}.git`, path] });

  let lastError = '';
  for (const attempt of attempts) {
    const result = await new Promise<{ code: number; stderr: string }>((resolve) => {
      execFile(
        attempt.file,
        attempt.args,
        { timeout: CLONE_TIMEOUT_MS, windowsHide: true, env, maxBuffer: 4_000_000 },
        (error, _stdout, stderr) => {
          const code = error && typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : error ? 1 : 0;
          resolve({ code, stderr: String(stderr ?? '') });
        },
      );
    });
    if (result.code === 0) return { ok: true, path, method: attempt.method };
    lastError = result.stderr.trim() || `${attempt.file} exited with ${result.code}`;
    // A failed clone can leave a partial folder; clear it for the next attempt.
    try {
      if (existsSync(path) && !existsSync(join(path, '.git'))) rmDirectory(path);
    } catch {
      // Best effort only.
    }
  }

  return { ok: false, path, method: 'git', error: lastError };
}

function rmDirectory(path: string): void {
  rmSync(path, { recursive: true, force: true });
}
