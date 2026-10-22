import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { IGNORED_DIRS, MAX_TOOL_OUTPUT } from './tools/util.ts';

/**
 * A cheap symbol index: no parser, no dependency, just the declarations a
 * reader needs to find the right file. Cached by mtime+size so a turn costs a
 * handful of stats after the first build.
 */
const CACHE_VERSION = 1;
const MAX_FILES = 4_000;
const MAX_FILE_BYTES = 512_000;
const MAX_SYMBOLS_PER_FILE = 40;
const MAX_DEPTH = 14;

const EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java', '.kt', '.kts',
  '.cs', '.rb', '.php', '.swift', '.scala', '.lua', '.ex', '.exs', '.dart',
]);

interface FileEntry {
  mtimeMs: number;
  size: number;
  lines: number;
  symbols: string[];
}

interface Cache {
  version: number;
  builtAt: string;
  files: Record<string, FileEntry>;
}

export interface RepoMapOptions {
  query?: string;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface RepoMap {
  text: string;
  files: number;
  shown: number;
  truncated: boolean;
  cached: boolean;
}

export async function buildRepoMap(workspace: string, options: RepoMapOptions = {}): Promise<RepoMap> {
  const maxTokens = clamp(options.maxTokens ?? 3_000, 200, 12_000);
  const paths: string[] = [];
  walk(workspace, paths, 0);
  options.signal?.throwIfAborted();

  const previous = readCache(workspace);
  const files: Record<string, FileEntry> = {};
  let hits = 0;

  for (const absolute of paths) {
    const rel = relative(workspace, absolute).replace(/\\/g, '/');
    const info = statSync(absolute, { throwIfNoEntry: false });
    if (!info?.isFile() || info.size > MAX_FILE_BYTES) continue;
    const known = previous.files[rel];
    if (known && known.mtimeMs === info.mtimeMs && known.size === info.size) {
      files[rel] = known;
      hits++;
      continue;
    }
    let content: string;
    try {
      content = readFileSync(absolute, 'utf8');
    } catch {
      continue;
    }
    if (content.includes('\u0000')) continue;
    files[rel] = {
      mtimeMs: info.mtimeMs,
      size: info.size,
      lines: content === '' ? 0 : content.split(/\r?\n/).length,
      symbols: extractSymbols(rel, content),
    };
  }

  writeCache(workspace, { version: CACHE_VERSION, builtAt: new Date().toISOString(), files });
  options.signal?.throwIfAborted();

  return render(files, options.query, maxTokens, previous.files, hits === paths.length && hits > 0);
}

/** One line per file, with its declarations, trimmed to a token budget. */
function render(
  files: Record<string, FileEntry>,
  query: string | undefined,
  maxTokens: number,
  previous: Record<string, FileEntry>,
  cached: boolean,
): RepoMap {
  const terms = (query ?? '')
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 0);

  const entries = Object.entries(files).map(([path, entry]) => {
    let score = 0;
    for (const term of terms) {
      if (path.toLowerCase().includes(term)) score += 6;
      if (entry.symbols.some((symbol) => symbol.toLowerCase().includes(term))) score += 4;
    }
    return { path, entry, score };
  });

  entries.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    return a.path.localeCompare(b.path);
  });

  const lines: string[] = [];
  let chars = 0;
  let shown = 0;
  const hasMatches = terms.length > 0 && entries.some((entry) => entry.score > 0);
  for (const { path, entry, score } of entries) {
    // With a query, keep the map focused (but never return nothing).
    if (hasMatches && score === 0) continue;
    const line = `${path} (${entry.lines} lines)\n  ${entry.symbols.join(', ') || '(no top-level symbols)'}`;
    if ((chars + line.length) / 4 > maxTokens && shown > 0) {
      return { text: finish(lines, files, shown, true), files: Object.keys(files).length, shown, truncated: true, cached };
    }
    lines.push(line);
    chars += line.length;
    shown++;
  }

  return {
    text: finish(lines, files, shown, false),
    files: Object.keys(files).length,
    shown,
    truncated: false,
    cached,
  };
}

function finish(lines: string[], files: Record<string, FileEntry>, shown: number, truncated: boolean): string {
  const total = Object.keys(files).length;
  const header = `Repo map: ${shown} of ${total} file(s)`;
  const footer = truncated
    ? `\n[map truncated to fit the token budget — pass a query (e.g. /map agent) or raise max_tokens for more]`
    : '';
  const body = lines.length === 0 ? '(no matching source files)' : lines.join('\n');
  return clip(`${header}\n${body}${footer}`);
}

function clip(text: string): string {
  if (text.length <= MAX_TOOL_OUTPUT) return text;
  return `${text.slice(0, MAX_TOOL_OUTPUT)}\n… [repo map clipped]`;
}

/** Regex declarations are deliberately shallow: names and locations, not types. */
export function extractSymbols(path: string, content: string): string[] {
  const extension = extensionOf(path);
  const patterns: RegExp[] = [];
  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(extension)) {
    patterns.push(
      /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var|namespace)\s+([A-Za-z_$][\w$]*)/,
    );
  } else if (extension === '.py') {
    patterns.push(/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/, /^\s*class\s+([A-Za-z_]\w*)/);
  } else if (extension === '.go') {
    patterns.push(/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, /^type\s+([A-Za-z_]\w*)/);
  } else if (extension === '.rs') {
    patterns.push(/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:fn|struct|enum|trait|impl|mod|const|static)\s+([A-Za-z_]\w*)/);
  } else if (['.java', '.kt', '.kts', '.cs', '.swift', '.scala', '.dart'].includes(extension)) {
    patterns.push(
      /^\s*(?:public|private|protected|internal|abstract|static|final|sealed|open|data|partial|export)?\s*(?:class|interface|enum|record|struct|object)\s+([A-Za-z_]\w*)/,
    );
  } else if (extension === '.rb') {
    patterns.push(/^\s*(?:class|module|def)\s+([A-Za-z_]\w*[!?=]?)/);
  } else if (extension === '.php') {
    patterns.push(/^\s*(?:abstract\s+|final\s+)?(?:class|interface|trait|function)\s+([A-Za-z_]\w*)/);
  } else if (['.lua', '.ex', '.exs'].includes(extension)) {
    patterns.push(/^\s*(?:local\s+)?(?:function|defmodule|def|defp)\s+([A-Za-z_]\w*[!?]?)/);
  }

  const symbols: string[] = [];
  const seen = new Set<string>();
  for (const line of content.split(/\r?\n/)) {
    if (symbols.length >= MAX_SYMBOLS_PER_FILE) break;
    for (const pattern of patterns) {
      const match = pattern.exec(line);
      const name = match?.[1];
      if (name && !seen.has(name)) {
        seen.add(name);
        symbols.push(name);
      }
    }
  }
  return symbols;
}

function extensionOf(path: string): string {
  const index = path.lastIndexOf('.');
  return index === -1 ? '' : path.slice(index).toLowerCase();
}

function walk(dir: string, out: string[], depth: number): void {
  if (out.length >= MAX_FILES || depth > MAX_DEPTH) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= MAX_FILES) return;
    if (entry.name.startsWith('.') && entry.name !== '.') continue;
    if (IGNORED_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out, depth + 1);
    } else if (entry.isFile() && EXTENSIONS.has(extensionOf(entry.name))) {
      out.push(full);
    }
  }
}

function cachePath(workspace: string): string {
  return join(workspace, '.vaelen', 'repomap.json');
}

function readCache(workspace: string): Cache {
  try {
    const parsed = JSON.parse(readFileSync(cachePath(workspace), 'utf8')) as Cache;
    if (parsed.version === CACHE_VERSION && parsed.files && typeof parsed.files === 'object') return parsed;
  } catch {
    // A missing or stale cache is simply rebuilt.
  }
  return { version: CACHE_VERSION, builtAt: '', files: {} };
}

function writeCache(workspace: string, cache: Cache): void {
  try {
    const path = cachePath(workspace);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(cache)}\n`, 'utf8');
  } catch {
    // The map still works without a cache.
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}
