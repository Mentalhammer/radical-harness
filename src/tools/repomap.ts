import type { ToolSpec } from '../types.ts';
import { buildRepoMap } from '../repomap.ts';
import { optionalNumber, optionalString } from './util.ts';

export const repoMapTool: ToolSpec = {
  name: 'repo_map',
  description:
    'A compact symbol map of the workspace (file paths plus top-level declarations), cached between calls. ' +
    'Use it to find the right files in a large repo before reading or grepping them.',
  readOnly: true,
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Only show files whose path or symbols match these words' },
      max_tokens: { type: 'number', description: 'Approximate size budget (default 3000, max 12000)' },
    },
    required: [],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const map = await buildRepoMap(ctx.workspace, {
      query: optionalString(args, 'query'),
      maxTokens: Math.floor(optionalNumber(args, 'max_tokens') ?? 3_000),
      signal: ctx.signal,
    });
    return { content: map.text };
  },
};
