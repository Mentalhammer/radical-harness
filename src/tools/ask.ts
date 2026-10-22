import type { ToolOutcome, ToolSpec } from '../types.ts';
import { ToolError, requiredString } from './util.ts';

const MAX_QUESTION_CHARS = 2_000;
const MAX_OPTION_CHARS = 160;
const MAX_OPTIONS = 6;
const MAX_ANSWER_CHARS = 4_000;

/**
 * The model's only way to pause and ask. It never touches the workspace, so it
 * stays available in read-only mode, where a clarification is often exactly
 * what a turn needs.
 */
export const askUserTool: ToolSpec = {
  name: 'ask_user',
  description:
    'Ask the user a direct question and wait for the answer. Use it when a request is ambiguous or a choice changes the work. Pass 2-6 short options when the answer is a choice.',
  readOnly: true,
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The question, one or two sentences' },
      options: {
        type: 'array',
        items: { type: 'string' },
        description: `Optional short choices (2-${MAX_OPTIONS}); the user may still type a free-form answer`,
      },
    },
    required: ['question'],
    additionalProperties: false,
  },
  async run(args, ctx): Promise<ToolOutcome> {
    const question = requiredString(args, 'question').trim();
    if (question.length > MAX_QUESTION_CHARS) {
      throw new ToolError(`question is too long (max ${MAX_QUESTION_CHARS.toLocaleString()} characters)`);
    }

    const options = parseOptions(args.options);
    if (!ctx.ask) {
      return {
        content:
          'No question channel is available in this session (one-shot mode has no console). Ask the question in your reply instead.',
        isError: true,
      };
    }

    const answer = await ctx.ask({ question, options });
    if (ctx.signal.aborted) return { content: 'The user interrupted before answering.', isError: true };
    if (answer === null) {
      return { content: 'The user did not answer the question.', isError: true };
    }

    const shown = answer.trim() === '' ? '(no text)' : answer.slice(0, MAX_ANSWER_CHARS);
    return { content: `The user answered: ${shown}` };
  },
};

function parseOptions(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new ToolError('options must be an array of short strings');

  const options = raw
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter((value) => value !== '');

  if (options.length === 0) return [];
  if (options.length === 1) {
    throw new ToolError('Pass at least two options, or none at all for a free-form answer');
  }
  if (options.length > MAX_OPTIONS) {
    throw new ToolError(`At most ${MAX_OPTIONS} options are allowed`);
  }
  const tooLong = options.find((option) => option.length > MAX_OPTION_CHARS);
  if (tooLong !== undefined) {
    throw new ToolError(`options must be at most ${MAX_OPTION_CHARS} characters ("${tooLong.slice(0, 40)}…")`);
  }
  return options;
}
