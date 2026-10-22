import { readFile, stat } from 'node:fs/promises';
import { textTokens } from '../context.ts';
import { decodeToon, encodeToon, type Json } from '../toon.ts';
import type { ToolOutcome, ToolSpec } from '../types.ts';
import { ToolError, optionalString, requiredString, truncate } from './util.ts';

const MAX_FILE_BYTES = 5_000_000;
const MAX_INLINE_CHARS = 200_000;

function parseJson(text: string, label: string): Json {
  try {
    return JSON.parse(text) as Json;
  } catch (error) {
    throw new ToolError(`${label} is not valid JSON: ${(error as Error).message}`);
  }
}

/** Compact JSON: the decoded form, minified. */
function compact(value: Json): string {
  return JSON.stringify(value);
}

function percent(from: number, to: number): number {
  return from === 0 ? 0 : Math.round((1 - to / from) * 100);
}

export const toonTool: ToolSpec = {
  name: 'toon',
  description:
    'Encode JSON to TOON (compact, lossless tables) or decode it back; use it to read large .json files cheaply.',
  readOnly: true,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace .json file to encode, or .toon file to decode' },
      json: { type: 'string', description: 'Inline JSON to encode' },
      toon: { type: 'string', description: 'Inline TOON to decode' },
      direction: { type: 'string', description: '"encode" (default) or "decode"; only with path' },
    },
    required: [],
    additionalProperties: false,
  },

  async run(args, ctx): Promise<ToolOutcome> {
    const path = optionalString(args, 'path');
    const inlineJson = typeof args.json === 'string' ? args.json : undefined;
    const inlineToon = typeof args.toon === 'string' ? args.toon : undefined;
    const requested = optionalString(args, 'direction')?.trim().toLowerCase();
    if (requested !== undefined && requested !== 'encode' && requested !== 'decode') {
      throw new ToolError(`direction must be "encode" or "decode", not "${requested}"`);
    }
    // Inline "toon" implies decoding; everything else defaults to encoding.
    const direction = requested ?? (inlineToon !== undefined ? 'decode' : 'encode');

    const sources = [path !== undefined, inlineJson !== undefined, inlineToon !== undefined].filter(Boolean).length;
    if (sources === 0) throw new ToolError('Pass one of "path", "json", or "toon"');
    if (sources > 1) throw new ToolError('Pass exactly one of "path", "json", or "toon"');
    if (inlineJson !== undefined && direction === 'decode') {
      throw new ToolError('"json" is encoded; use "toon" to decode');
    }
    if (inlineToon !== undefined && direction === 'encode') {
      throw new ToolError('"toon" is decoded; use "json" to encode');
    }

    if (inlineToon !== undefined) {
      return { content: truncate(compact(decodeToon(inlineToon))) };
    }

    if (inlineJson !== undefined) {
      if (inlineJson.length > MAX_INLINE_CHARS) {
        throw new ToolError(`Inline JSON is too large (max ${MAX_INLINE_CHARS.toLocaleString()} characters)`);
      }
      const value = parseJson(inlineJson, 'The "json" argument');
      const encoded = encodeToon(value);
      const before = textTokens(inlineJson);
      const after = textTokens(encoded);
      const note =
        after >= before
          ? `[no smaller than JSON here: ${before} → ${after} tokens]`
          : `[${percent(before, after)}% smaller: ${before} → ${after} tokens]`;
      return { content: truncate(`${encoded}\n\n${note}`) };
    }

    const input = requiredString(args, 'path');
    const absolute = ctx.permissions.resolvePath(input, 'read');
    const info = await stat(absolute).catch(() => null);
    if (!info) throw new ToolError(`File not found: ${input}`);
    if (info.isDirectory()) throw new ToolError(`${input} is a directory — pass a file`);
    if (info.size > MAX_FILE_BYTES) {
      throw new ToolError(`${input} is ${(info.size / 1e6).toFixed(1)} MB — too large to convert at once`);
    }

    const raw = await readFile(absolute, 'utf8');
    if (raw.includes('\u0000')) throw new ToolError(`${input} looks like a binary file`);

    if (direction === 'decode') {
      return { content: truncate(compact(decodeToon(raw))) };
    }

    const value = parseJson(raw, input);
    const encoded = encodeToon(value);
    const before = textTokens(raw);
    const after = textTokens(encoded);
    const note =
      after >= before
        ? `[no smaller than this JSON: ${before} → ${after} tokens]`
        : `[${percent(before, after)}% smaller: ${before} → ${after} tokens]`;
    return { content: truncate(`${encoded}\n\n${note}`) };
  },
};
