import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { textTokens } from '../context.ts';
import { encodeToon, type Json } from '../toon.ts';
import type { ToolSpec } from '../types.ts';
import {
  IGNORED_DIRS,
  ToolError,
  filesystemError,
  optionalBoolean,
  optionalNumber,
  optionalString,
  relativePath,
  requiredString,
  truncate,
  unifiedDiff,
} from './util.ts';

const MAX_READ_LINES = 2000;
/** Above this size TOON usually wins; below it the header and footer outweigh the saving. */
const AUTO_TOON_MIN_CHARS = 8_000;
/** Only auto-switch when the encoding is at least this much smaller than the file. */
const AUTO_TOON_MIN_SAVING = 20;
const MAX_GREP_RESULTS = 200;
/** Guards against pathological inputs that would build enormous regexes. */
const MAX_GLOB_PATTERN = 512;
const MAX_EDIT_NEEDLE = 200_000;
/** Never slurp a giant existing file just to report its line count. */
const MAX_REWRITE_PREVIEW_BYTES = 2_000_000;
/** Editing reads the whole file first, so it gets the same guard as read_file. */
const MAX_EDIT_FILE_BYTES = 5_000_000;
/** Bounds memory when a workspace holds a huge log or database dump. */
const MAX_GREP_FILE_BYTES = 2_000_000;
/** The walk is bounded, so say so instead of reporting a complete-looking list. */
const MAX_GLOB_FILES = 5000;
const MAX_GLOB_RESULTS = 200;

export const readFileTool: ToolSpec = {
  name: 'read_file',
  description:
    'Read a workspace text file. Returns line-numbered content; use offset/limit for large files. ' +
    'Large JSON files come back as TOON (compact) unless format is "text".',
  readOnly: true,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace-relative path' },
      offset: { type: 'number', description: '1-based start line' },
      limit: { type: 'number', description: `Max lines (default 400, max ${MAX_READ_LINES})` },
      format: { type: 'string', description: '"auto" (default), "text", or "toon" for JSON' },
    },
    required: ['path'],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const input = requiredString(args, 'path');
    const absolute = ctx.permissions.resolvePath(input, 'read');
    const info = await stat(absolute).catch(() => null);
    if (!info) throw new ToolError(`File not found: ${input}`);
    if (info.isDirectory()) {
      throw new ToolError(`${input} is a directory — use list_directory or glob instead`);
    }
    if (info.size > 5_000_000) {
      throw new ToolError(`${input} is ${(info.size / 1e6).toFixed(1)} MB — too large to read at once`);
    }

    const raw = await readFile(absolute, 'utf8');
    if (raw.includes('\u0000')) throw new ToolError(`${input} looks like a binary file`);

    const format = (optionalString(args, 'format') ?? 'auto').trim().toLowerCase();
    if (format !== 'auto' && format !== 'text' && format !== 'toon') {
      throw new ToolError(`format must be "auto", "text", or "toon", not "${format}"`);
    }
    const hasSlice = optionalNumber(args, 'offset') !== undefined || optionalNumber(args, 'limit') !== undefined;
    if (format === 'toon' && hasSlice) {
      throw new ToolError('offset and limit apply to text; omit them with format "toon"');
    }

    const lines = raw.split(/\r?\n/);
    if (format !== 'text') {
      const document = parseJsonDocument(raw);
      if (!document && format === 'toon') {
        throw new ToolError(`${input} is not a JSON object or array, so it cannot be encoded as TOON`);
      }
      if (document) {
        const encoded = encodeToon(document);
        const rawTokens = textTokens(raw);
        const toonTokens = textTokens(encoded);
        const saved = rawTokens === 0 ? 0 : Math.round((1 - toonTokens / rawTokens) * 100);
        const size = saved >= 0 ? `${saved}% smaller` : `${Math.abs(saved)}% larger`;
        // Auto only without a line slice: offset/limit are text coordinates.
        const compact = format === 'toon' || (format === 'auto' && !hasSlice && raw.length >= AUTO_TOON_MIN_CHARS && saved >= AUTO_TOON_MIN_SAVING);
        if (compact) {
          const header = `${relativePath(ctx.workspace, absolute)} — ${lines.length} lines, TOON ${size} (${rawTokens} → ${toonTokens} tokens)`;
          return {
            content: `${header}\n${truncate(encoded)}\n[TOON has no line numbers: read with format "text" before editing.]`,
          };
        }
      }
    }

    const offset = Math.max(1, Math.floor(optionalNumber(args, 'offset') ?? 1));
    const limit = clamp(Math.floor(optionalNumber(args, 'limit') ?? 400), 1, MAX_READ_LINES);
    const slice = lines.slice(offset - 1, offset - 1 + limit);

    if (slice.length === 0) {
      return { content: `${input} has ${lines.length} lines; offset ${offset} is past the end.` };
    }

    const numbered = slice
      .map((line, index) => {
        const shown = line.length > 2000 ? `${line.slice(0, 2000)}…` : line;
        return `${String(offset + index).padStart(5)}| ${shown}`;
      })
      .join('\n');

    const last = offset + slice.length - 1;
    const suffix = last < lines.length ? `\n[showing lines ${offset}-${last} of ${lines.length}]` : '';
    return { content: truncate(`${relativePath(ctx.workspace, absolute)}\n${numbered}${suffix}`) };
  },
};

export const writeFileTool: ToolSpec = {
  name: 'write_file',
  description: 'Create or replace a file. Prefer edit_file for targeted changes.',
  readOnly: false,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      content: { type: 'string', description: 'Full contents; empty string creates an empty file' },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const input = requiredString(args, 'path');
    if (typeof args.content !== 'string') throw new ToolError('Missing required string argument "content"');
    if (args.content.length > 2_000_000) {
      throw new ToolError(`content is too large (${args.content.length.toLocaleString()} chars, max 2,000,000) — split the file or use apply_patch`);
    }
    const absolute = ctx.permissions.resolvePath(input, 'write');
    await ctx.permissions.approveWrite(absolute);

    const info = await stat(absolute).catch(() => null);
    if (info?.isDirectory()) throw new ToolError(`${input} is a directory`);

    const previous =
      info && info.size <= MAX_REWRITE_PREVIEW_BYTES
        ? await readFile(absolute, 'utf8').catch(() => '')
        : null;
    ctx.checkpoints?.snapshot(absolute);
    try {
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, args.content, 'utf8');
    } catch (error) {
      throw filesystemError(`Could not write ${relativePath(ctx.workspace, absolute)}`, error);
    }

    const lineCount = args.content === '' ? 0 : args.content.split('\n').length;
    if (!info) return { content: `Created ${relativePath(ctx.workspace, absolute)} (${lineCount} lines)`, mutated: true };
    if (previous === null) {
      return { content: `Overwrote ${relativePath(ctx.workspace, absolute)} (${lineCount} lines)`, mutated: true };
    }

    const before = previous === '' ? 0 : previous.split('\n').length;
    const preview = previous !== null ? `\n${unifiedDiff(previous, args.content)}` : '';
    return {
      content: `Overwrote ${relativePath(ctx.workspace, absolute)} (${before} → ${lineCount} lines)${preview}`,
      mutated: true,
    };
  },
};

export const editFileTool: ToolSpec = {
  name: 'edit_file',
  description:
    'Replace an exact string in a file. old_string must match once unless replace_all is true; read the file first.',
  readOnly: false,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      old_string: { type: 'string', description: 'Exact text to replace, including indentation' },
      new_string: { type: 'string', description: 'Replacement text' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence' },
    },
    required: ['path', 'old_string', 'new_string'],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const input = requiredString(args, 'path');
    const oldString = requiredString(args, 'old_string');
    if (typeof args.new_string !== 'string') throw new ToolError('Missing required string argument "new_string"');
    if (oldString === args.new_string) throw new ToolError('old_string and new_string are identical');
    if (oldString.length > MAX_EDIT_NEEDLE) {
      throw new ToolError(
        `old_string is too large (${oldString.length.toLocaleString()} chars, max ${MAX_EDIT_NEEDLE.toLocaleString()}). ` +
          'Use write_file for a full rewrite, or edit a smaller region.',
      );
    }

    const absolute = ctx.permissions.resolvePath(input, 'write');
    await ctx.permissions.approveWrite(absolute);

    const info = await stat(absolute).catch(() => null);
    if (!info) throw new ToolError(`File not found: ${input}`);
    if (info.isDirectory()) throw new ToolError(`${input} is a directory`);
    if (info.size > MAX_EDIT_FILE_BYTES) {
      throw new ToolError(`${input} is ${(info.size / 1e6).toFixed(1)} MB — too large to edit at once`);
    }

    const original = await readFile(absolute, 'utf8');

    // A file that mixes CRLF and LF lines cannot be normalized and converted
    // back without rewriting lines the edit never touched, so those are
    // matched exactly and written back byte-for-byte.
    const hadCrlf = original.includes('\r\n');
    const mixedEndings = hadCrlf && /(^|[^\r])\n/.test(original);
    const normalize = hadCrlf && !mixedEndings;
    const normalized = normalize ? original.replace(/\r\n/g, '\n') : original;
    const needle = normalize ? oldString.replace(/\r\n/g, '\n') : oldString;
    const replacement = normalize ? args.new_string.replace(/\r\n/g, '\n') : args.new_string;

    const count = occurrences(normalized, needle);
    // Tolerate whitespace-only drift, but only for locating the match: the
    // replacement is still applied to the original text so untouched lines
    // keep their exact bytes. Mixed endings stay exact, since a loose match
    // would have to guess which newline form the file uses.
    const loose = count === 0 && !mixedEndings ? looseMatch(normalized, needle) : null;
    const total = loose ? loose.count : count;

    if (total === 0) {
      throw new ToolError(
        `old_string not found in ${input}. Re-read the file and copy the exact text, including indentation.` +
          (mixedEndings ? ' This file mixes CRLF and LF line endings, so the match must be exact.' : ''),
      );
    }

    const replaceAll = optionalBoolean(args, 'replace_all');
    if (total > 1 && !replaceAll) {
      const lines = (loose ? loose.lines : lineNumbersOf(normalized, needle)).join(', ');
      throw new ToolError(
        `old_string matches ${total} times in ${input} (lines ${lines}). ` +
          'Include more surrounding context to make it unique, or pass replace_all: true.',
      );
    }

    const replaced = loose
      ? normalized.replace(loose.pattern(replaceAll), () => replacement)
      : replaceAll
        ? normalized.split(needle).join(replacement)
        : normalized.replace(needle, replacement);

    const output = normalize ? replaced.replace(/\n/g, '\r\n') : replaced;
    ctx.checkpoints?.snapshot(absolute);
    try {
      await writeFile(absolute, output, 'utf8');
    } catch (error) {
      throw filesystemError(`Could not write ${relativePath(ctx.workspace, absolute)}`, error);
    }

    const beforeLines = original.split('\n').length;
    const afterLines = output.split('\n').length;
    const preview = unifiedDiff(original, output);
    const note = loose ? ' (matched ignoring trailing whitespace)' : '';
    return {
      content:
        `Edited ${relativePath(ctx.workspace, absolute)} — replaced ${total} occurrence(s)` +
        `${note}, ${beforeLines} → ${afterLines} lines\n${preview}`,
      mutated: true,
    };
  },
};

export const listDirectoryTool: ToolSpec = {
  name: 'list_directory',
  description: "List a workspace directory's immediate contents.",
  readOnly: true,
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Defaults to the workspace root' } },
    required: [],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const input = optionalString(args, 'path') ?? '.';
    const absolute = ctx.permissions.resolvePath(input, 'read');
    const entries = await readdir(absolute, { withFileTypes: true }).catch(() => {
      throw new ToolError(`Directory not found: ${input}`);
    });
    if (entries.length === 0) return { content: `${input} is empty` };

    const rows = entries
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      .map((entry) => `${entry.isDirectory() ? 'dir ' : 'file'}  ${entry.name}`);
    return { content: truncate(`${relativePath(ctx.workspace, absolute)}/\n${rows.join('\n')}`) };
  },
};

export const globTool: ToolSpec = {
  name: 'glob',
  description:
    'Find files by glob pattern, e.g. "**/*.ts" or "src/**/test_*.py". Skips dependencies and build output.',
  readOnly: true,
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string' },
      path: { type: 'string', description: 'Directory to search from (default: workspace root)' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const pattern = requiredString(args, 'pattern').replace(/\\/g, '/');
    if (pattern.length > MAX_GLOB_PATTERN) {
      throw new ToolError(`Glob pattern is too long (max ${MAX_GLOB_PATTERN} characters)`);
    }
    if (pattern.startsWith('!')) {
      throw new ToolError('Negated globs like "!*.ts" are not supported — pass a positive pattern');
    }
    const root = ctx.permissions.resolvePath(optionalString(args, 'path') ?? '.', 'read');
    const matcher = globToRegExp(pattern);

    const files: string[] = [];
    await walk(root, files, 0);
    const hitWalkCap = files.length >= MAX_GLOB_FILES;
    const all = files
      .map((file) => relative(ctx.workspace, file).replace(/\\/g, '/'))
      .filter((rel) => matcher.test(rel) || matcher.test(rel.slice(rel.lastIndexOf('/') + 1)))
      .sort();
    const matches = all.slice(0, MAX_GLOB_RESULTS);

    if (matches.length === 0) return { content: `No files matched ${pattern}` };

    const notes: string[] = [];
    if (all.length > matches.length) {
      notes.push(`[showing the first ${matches.length} of ${all.length} matches]`);
    }
    if (hitWalkCap) notes.push(`[stopped after ${MAX_GLOB_FILES.toLocaleString()} files]`);
    return {
      content: truncate(
        `${matches.length} file(s) matched ${pattern}\n${matches.join('\n')}` +
          (notes.length > 0 ? `\n${notes.join('\n')}` : ''),
      ),
    };
  },
};

export const grepTool: ToolSpec = {
  name: 'grep',
  description: 'Search file contents with a regex; returns file:line: text.',
  readOnly: true,
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'JavaScript regex' },
      path: { type: 'string', description: 'File or directory to search (default: workspace root)' },
      glob: { type: 'string', description: 'Only search files matching this glob, e.g. "*.ts"' },
      case_sensitive: { type: 'boolean' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const pattern = requiredString(args, 'pattern');
    const scope = ctx.permissions.resolvePath(optionalString(args, 'path') ?? '.', 'read');
    const include = optionalString(args, 'glob');
    if (include && include.length > MAX_GLOB_PATTERN) {
      throw new ToolError(`Glob pattern is too long (max ${MAX_GLOB_PATTERN} characters)`);
    }
    const caseSensitive = optionalBoolean(args, 'case_sensitive');

    const regex = buildRegex(pattern, caseSensitive);
    const info = await stat(scope).catch(() => null);
    if (!info) throw new ToolError(`Path not found: ${optionalString(args, 'path')}`);

    const candidates: string[] = [];
    if (info.isFile()) {
      candidates.push(scope);
    } else {
      await walk(scope, candidates, 0);
    }

    const includeMatcher = include ? globToRegExp(include.replace(/\\/g, '/')) : null;
    const results: string[] = [];
    let matchedFiles = 0;
    let truncated = false;

    for (const file of candidates) {
      const rel = relative(ctx.workspace, file).replace(/\\/g, '/');
      if (includeMatcher && !includeMatcher.test(rel) && !includeMatcher.test(rel.slice(rel.lastIndexOf('/') + 1))) {
        continue;
      }
      const fileInfo = await stat(file).catch(() => null);
      if (!fileInfo || fileInfo.size > MAX_GREP_FILE_BYTES) continue;
      const content = await readFile(file, 'utf8').catch(() => null);
      if (content === null || content.includes('\u0000')) continue;

      let fileMatched = false;
      const lines = content.split(/\r?\n/);
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index] ?? '';
        if (!regex.test(line)) continue;
        fileMatched = true;
        if (results.length >= MAX_GREP_RESULTS) {
          truncated = true;
          break;
        }
        const shown = line.length > 300 ? `${line.slice(0, 300)}…` : line;
        results.push(`${rel}:${index + 1}: ${shown}`);
      }
      if (fileMatched) matchedFiles++;
      if (truncated) break;
    }

    if (results.length === 0) return { content: `No matches for /${pattern}/` };
    const footer = truncated ? `\n[stopped at ${MAX_GREP_RESULTS} matches]` : '';
    return {
      content: truncate(
        `${results.length} match(es) in ${matchedFiles} file(s)\n${results.join('\n')}${footer}`,
      ),
    };
  },
};

/** Parses a JSON object or array document; anything else is not a candidate. */
function parseJsonDocument(raw: string): Json | null {
  const first = raw.trimStart()[0];
  if (first !== '{' && first !== '[') return null;
  try {
    return JSON.parse(raw) as Json;
  } catch {
    return null;
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function occurrences(haystack: string, needle: string): number {
  if (needle === '') return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count++;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

function lineNumbersOf(haystack: string, needle: string): number[] {
  const lines: number[] = [];
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    lines.push(haystack.slice(0, index).split('\n').length);
    index = haystack.indexOf(needle, index + needle.length);
  }
  return lines;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Builds a pattern that matches `needle` while tolerating trailing spaces on
 * any line. Used only to locate the match; every other character must be exact.
 */
function loosePattern(needle: string): RegExp {
  const lines = needle.split('\n');
  let body = '';
  for (let index = 0; index < lines.length; index++) {
    const isLast = index === lines.length - 1;
    const content = escapeRegExp((lines[index] ?? '').replace(/[ \t]+$/, ''));
    // A needle ending in a newline must not swallow the next line's indentation.
    if (isLast && content === '') return new RegExp(body, 'g');
    body += content + (isLast ? '' : '[ \\t]*\\n');
  }
  // Allow the whitespace the exact match refused on the final line.
  return new RegExp(`${body}[ \\t]*`, 'g');
}

/** Finds `needle` in `text` ignoring trailing whitespace, without mutating the text. */
function looseMatch(
  text: string,
  needle: string,
): { count: number; lines: number[]; pattern: (all: boolean) => RegExp } | null {
  // A whitespace-only needle would match everywhere; refuse instead.
  if (needle.replace(/\s/g, '') === '') return null;

  const source = loosePattern(needle);
  const matches = [...text.matchAll(source)];
  if (matches.length === 0) return null;

  return {
    count: matches.length,
    lines: matches.map((match) => text.slice(0, match.index ?? 0).split('\n').length),
    pattern: (all: boolean) => (all ? source : new RegExp(source.source)),
  };
}

function buildRegex(pattern: string, caseSensitive: boolean): RegExp {
  if (pattern.length > 500) throw new ToolError('Search pattern is too long (max 500 characters)');
  try {
    return new RegExp(pattern, caseSensitive ? '' : 'i');
  } catch {
    throw new ToolError(`Invalid regex /${pattern.slice(0, 120)}/ — escape brackets or use a simpler pattern`);
  }
}

function globToRegExp(pattern: string): RegExp {
  let out = '';
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index] ?? '';
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        if (pattern[index + 2] === '/') {
          out += '(?:.*/)?';
          index += 2;
        } else {
          out += '.*';
          index += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (char === '?') {
      out += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(char)) {
      out += `\\${char}`;
    } else {
      out += char;
    }
  }
  return new RegExp(`^${out}$`);
}

async function walk(dir: string, out: string[], depth: number): Promise<void> {
  if (out.length >= MAX_GLOB_FILES || depth > 12) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= MAX_GLOB_FILES) return;
    if (IGNORED_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, out, depth + 1);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
}
