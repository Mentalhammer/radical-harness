import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ToolSpec } from '../types.ts';
import { optionalBoolean, requiredString, ToolError, truncate, unifiedDiff } from './util.ts';

/**
 * A compact patch format: one header per file, then `@@` hunks with ` ` / `-` /
 * `+` lines. It is the same shape Codex-style models already emit, and it makes
 * a multi-file change one tool call instead of N edit_file calls.
 *
 * *** Begin Patch
 * *** Update File: src/app.ts
 * @@
 *  unchanged
 * -old
 * +new
 * *** Add File: src/new.ts
 * +hello
 * *** Delete File: src/old.ts
 * *** End Patch
 */
interface Hunk {
  oldLines: string[];
  newLines: string[];
  header: string;
}

type Operation =
  | { kind: 'add'; path: string; lines: string[] }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; hunks: Hunk[] };

const MAX_PATCH_BYTES = 2_000_000;
const MAX_PATCH_FILES = 50;

export function parsePatch(text: string): Operation[] {
  if (text.length > MAX_PATCH_BYTES) {
    throw new ToolError(`Patch is too large (${text.length.toLocaleString()} chars, max ${MAX_PATCH_BYTES.toLocaleString()})`);
  }
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let index = 0;
  while (index < lines.length && lines[index]?.trim() !== '*** Begin Patch') index++;
  if (index >= lines.length) {
    throw new ToolError('Patch must start with "*** Begin Patch"');
  }
  index++;

  const operations: Operation[] = [];
  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (line.trim() === '*** End Patch') return operations;
    if (line.trim() === '') {
      index++;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      const body: string[] = [];
      index++;
      while (index < lines.length && !lines[index]!.startsWith('*** ')) {
        const entry = lines[index] ?? '';
        if (entry.startsWith('+')) body.push(entry.slice(1));
        else if (entry.trim() !== '') {
          throw new ToolError(`Add File "${path}" has a line that does not start with "+": ${entry.slice(0, 120)}`);
        }
        index++;
      }
      operations.push({ kind: 'add', path, lines: body });
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      operations.push({ kind: 'delete', path: line.slice('*** Delete File: '.length).trim() });
      index++;
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim();
      index++;
      const hunks: Hunk[] = [];
      while (index < lines.length && !lines[index]!.startsWith('*** ')) {
        const entry = lines[index] ?? '';
        if (entry.trim() === '') {
          index++;
          continue;
        }
        if (!entry.startsWith('@@')) {
          throw new ToolError(
            `Update File "${path}": expected a "@@" hunk, got: ${entry.slice(0, 120)}`,
          );
        }
        const header = entry;
        index++;
        const oldLines: string[] = [];
        const newLines: string[] = [];
        while (index < lines.length) {
          const body = lines[index] ?? '';
          if (body.startsWith('@@') || body.startsWith('*** ')) break;
          if (body.startsWith('\\')) {
            // "\ No newline at end of file" carries no text.
            index++;
            continue;
          }
          if (body.startsWith(' ')) {
            oldLines.push(body.slice(1));
            newLines.push(body.slice(1));
          } else if (body.startsWith('-')) {
            oldLines.push(body.slice(1));
          } else if (body.startsWith('+')) {
            newLines.push(body.slice(1));
          } else if (body.trim() === '') {
            // A blank line in a hunk is an empty context line.
            oldLines.push('');
            newLines.push('');
          } else {
            throw new ToolError(
              `Update File "${path}": hunk lines must start with " ", "-", or "+", got: ${body.slice(0, 120)}`,
            );
          }
          index++;
        }
        if (oldLines.length === 0 && newLines.length === 0) continue;
        hunks.push({ oldLines, newLines, header });
      }
      if (hunks.length === 0) throw new ToolError(`Update File "${path}" has no hunks`);
      operations.push({ kind: 'update', path, hunks });
      continue;
    }

    throw new ToolError(`Unknown patch directive: ${line.slice(0, 120)}`);
  }

  throw new ToolError('Patch is missing "*** End Patch"');
}

export const applyPatchTool: ToolSpec = {
  name: 'apply_patch',
  description:
    'Apply a multi-file patch in one call. Use "*** Begin Patch", then "*** Add File:", ' +
    '"*** Update File:" with "@@" hunks (` ` context, `-` remove, `+` add), "*** Delete File:", ' +
    'and "*** End Patch". Prefer this to several edit_file calls for one change.',
  readOnly: false,
  parameters: {
    type: 'object',
    properties: {
      patch: { type: 'string', description: 'The patch text, starting with "*** Begin Patch"' },
      dry_run: { type: 'boolean', description: 'Report the changes without writing anything' },
    },
    required: ['patch'],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const operations = parsePatch(requiredString(args, 'patch'));
    if (operations.length === 0) throw new ToolError('The patch contains no file operations');
    if (operations.length > MAX_PATCH_FILES) {
      throw new ToolError(`The patch touches ${operations.length} files (max ${MAX_PATCH_FILES})`);
    }
    const dryRun = optionalBoolean(args, 'dry_run');
    const summary: string[] = [];

    for (const operation of operations) {
      const absolute = ctx.permissions.resolvePath(operation.path, 'write');
      if (!dryRun) await ctx.permissions.approveWrite(absolute);

      if (operation.kind === 'add') {
        const info = await stat(absolute).catch(() => null);
        if (info) throw new ToolError(`${operation.path} already exists — use Update File instead`);
        const content = operation.lines.length === 0 ? '' : `${operation.lines.join('\n')}\n`;
        if (!dryRun) {
          ctx.checkpoints?.snapshot(absolute);
          await mkdir(dirname(absolute), { recursive: true });
          await writeFile(absolute, content, 'utf8');
        }
        summary.push(`${dryRun ? 'Would add' : 'Added'} ${operation.path} (${operation.lines.length} lines)`);
        continue;
      }

      if (operation.kind === 'delete') {
        const info = await stat(absolute).catch(() => null);
        if (!info || !info.isFile()) throw new ToolError(`File not found: ${operation.path}`);
        if (!dryRun) {
          ctx.checkpoints?.snapshot(absolute);
          await unlink(absolute);
        }
        summary.push(`${dryRun ? 'Would delete' : 'Deleted'} ${operation.path}`);
        continue;
      }

      const info = await stat(absolute).catch(() => null);
      if (!info || !info.isFile()) throw new ToolError(`File not found: ${operation.path}`);
      if (info.size > 5_000_000) throw new ToolError(`${operation.path} is too large to patch`);
      const original = await readFile(absolute, 'utf8');
      const { output, applied } = applyHunks(original, operation.hunks, operation.path);
      const before = original === '' ? 0 : original.split('\n').length;
      const after = output === '' ? 0 : output.split('\n').length;
      const preview = truncate(unifiedDiff(original, output, 60), 4000);
      if (!dryRun) {
        ctx.checkpoints?.snapshot(absolute);
        await writeFile(absolute, output, 'utf8');
      }
      summary.push(
        `${dryRun ? 'Would update' : 'Updated'} ${operation.path} (${applied} hunk(s), ${before} → ${after} lines)\n${preview}`,
      );
    }

    const header = `${summary.length} file(s)${dryRun ? ' (dry run, nothing written)' : ''}`;
    return { content: truncate(`${header}\n${summary.join('\n')}`), mutated: !dryRun };
  },
};

/** Applies hunks sequentially and returns the new file content. */
export function applyHunks(
  original: string,
  hunks: Hunk[],
  path = 'file',
): { output: string; applied: number } {
  const crlf = original.includes('\r\n');
  const mixed = crlf && /(^|[^\r])\n/.test(original);
  const lines = original.split(/\r?\n/);
  let cursor = 0;
  let applied = 0;

  for (const hunk of hunks) {
    const found = findHunk(lines, hunk.oldLines, cursor) ?? findHunk(lines, hunk.oldLines, 0);
    if (found === null) {
      const first = hunk.oldLines.find((line) => line.trim() !== '') ?? hunk.header;
      throw new ToolError(
        `Hunk ${applied + 1} for ${path} did not match: ${JSON.stringify(first.slice(0, 120))}. ` +
          'Re-read the file and copy the exact lines, including indentation.',
      );
    }
    lines.splice(found, hunk.oldLines.length, ...hunk.newLines);
    cursor = found + hunk.newLines.length;
    applied++;
  }

  // A file that had one consistent ending keeps it; a mixed file is written
  // with LF, because there is no single correct choice for untouched lines.
  const output = crlf && !mixed ? lines.join('\r\n') : lines.join('\n');
  return { output, applied };
}

function findHunk(lines: string[], oldLines: string[], from: number): number | null {
  if (oldLines.length === 0) return Math.min(from, lines.length);
  for (let index = Math.max(0, from); index + oldLines.length <= lines.length; index++) {
    if (matches(lines, oldLines, index, false)) return index;
  }
  // Models often strip trailing whitespace when copying a hunk.
  for (let index = Math.max(0, from); index + oldLines.length <= lines.length; index++) {
    if (matches(lines, oldLines, index, true)) return index;
  }
  return null;
}

function matches(lines: string[], oldLines: string[], index: number, loose: boolean): boolean {
  for (let offset = 0; offset < oldLines.length; offset++) {
    const actual = lines[index + offset] ?? '';
    const expected = oldLines[offset] ?? '';
    if (loose ? actual.trimEnd() !== expected.trimEnd() : actual !== expected) return false;
  }
  return true;
}
