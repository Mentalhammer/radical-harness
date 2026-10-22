import type { ToolSpec } from '../types.ts';
import { optionalNumber, optionalString, requiredString, ToolError } from './util.ts';

export const taskTool: ToolSpec = {
  name: 'task',
  description:
    'Delegate a focused, self-contained task to a child agent with its own context. ' +
    'Use it for a broad search or a review whose file dumps would otherwise flood this conversation. ' +
    'The child returns a concise report; it cannot ask the user questions. Read-only unless mode is "edit".',
  // The child inherits the session permissions, so read mode still blocks edits.
  readOnly: true,
  parameters: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'What the subagent should do, including what to report back' },
      description: { type: 'string', description: 'A 3-6 word label for the UI' },
      mode: { type: 'string', description: '"read" (default) or "edit"' },
      tools: {
        type: 'array',
        description: 'Optional allow-list of tool names for the child',
        items: { type: 'string' },
      },
      model: { type: 'string', description: 'Optional model id for the child' },
      max_steps: { type: 'number', description: 'Child step limit (default 12, max 24)' },
    },
    required: ['prompt'],
    additionalProperties: false,
  },
  async run(args, ctx) {
    if (!ctx.subagent) throw new ToolError('Subagents are not available in this session');
    const prompt = requiredString(args, 'prompt');
    if (prompt.length > 20_000) throw new ToolError('The task prompt is too long (max 20,000 characters)');
    const mode = optionalString(args, 'mode') === 'edit' ? 'edit' : 'read';
    const tools = Array.isArray(args.tools)
      ? args.tools.filter((item): item is string => typeof item === 'string')
      : undefined;
    return ctx.subagent({
      prompt,
      description: optionalString(args, 'description'),
      mode,
      tools,
      model: optionalString(args, 'model'),
      max_steps: Math.floor(optionalNumber(args, 'max_steps') ?? 12),
    });
  },
};
