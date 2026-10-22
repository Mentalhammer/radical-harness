import { MAX_ATTACHMENT_CHARS, type Message, type ToolMessage } from './types.ts';

const CHARS_PER_TOKEN = 4;
const ELIDED = '[earlier tool output elided — see summary on system prompt]';
const TRIMMED_NOTE = '[Earlier conversation trimmed to fit the context window.]';

/** Cheap chars/4 estimate for arbitrary text (model replies, tool arguments). */
export function textTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

interface MessageSize {
  chars: number;
  imageTokens: number;
}

function sizeOf(message: Message): MessageSize {
  let chars = message.content.length;
  let imageTokens = 0;
  if (message.role === 'user') {
    for (const attachment of message.attachments ?? []) {
      if (attachment.kind === 'text') chars += Math.min(attachment.content?.length ?? 0, MAX_ATTACHMENT_CHARS);
      else imageTokens += 1_200;
    }
  }
  if (message.role === 'assistant') {
    for (const call of message.toolCalls) chars += JSON.stringify(call.args).length + call.name.length;
  }
  return { chars, imageTokens };
}

/**
 * Running transcript size. Compaction updates this instead of re-measuring the
 * whole transcript on every step, which used to make a long conversation O(n²).
 */
class TranscriptSize {
  #chars = 0;
  #imageTokens = 0;
  #messages = 0;

  constructor(messages: Message[]) {
    for (const message of messages) this.add(message);
  }

  get tokens(): number {
    return Math.ceil(this.#chars / CHARS_PER_TOKEN) + this.#imageTokens + this.#messages * 4;
  }

  add(message: Message): void {
    const size = sizeOf(message);
    this.#chars += size.chars;
    this.#imageTokens += size.imageTokens;
    this.#messages += 1;
  }

  remove(message: Message): void {
    const size = sizeOf(message);
    this.#chars -= size.chars;
    this.#imageTokens -= size.imageTokens;
    this.#messages -= 1;
  }

  /** Replaces a message's body, as compaction does when eliding tool output. */
  setContent(message: Message, content: string): void {
    this.#chars += content.length - message.content.length;
    message.content = content;
  }
}

export function estimateTokens(messages: Message[]): number {
  return new TranscriptSize(messages).tokens;
}

/**
 * Deterministic compaction: elide old tool output first, then drop whole turns.
 * Returns true when the transcript was modified.
 */
export function compact(messages: Message[], budget: number): boolean {
  const size = new TranscriptSize(messages);
  if (size.tokens <= budget) return false;
  let changed = false;

  for (const message of messages) {
    if (size.tokens <= budget) break;
    if (message.role === 'tool' && message.content.length > 400 && message.content !== ELIDED) {
      size.setContent(message, ELIDED);
      changed = true;
    }
  }

  if (size.tokens <= budget) return changed;

  const hasSystem = messages[0]?.role === 'system';
  const first = hasSystem ? 1 : 0;
  // The trimmed-notice lands on the system prompt, so budget for it up front;
  // otherwise adding it could push the transcript back over the limit.
  const hasNote = hasSystem && messages[0]?.content.includes(TRIMMED_NOTE) === true;
  const noteReserve = hasNote ? 0 : textTokens(`\n\n${TRIMMED_NOTE}`) + 4;
  // Walk forward turn by turn, subtracting sizes, then splice once. Splicing
  // per turn shifted the whole array every time, which is quadratic for a long
  // conversation even after the measurement itself became linear.
  let cut = first;
  let cursor = first;
  let trims = 0;

  while (messages.length - cut > 4) {
    if (size.tokens + noteReserve <= budget) break;
    while (cursor < messages.length && messages[cursor]?.role !== 'user') cursor++;
    if (cursor >= messages.length) break;
    const start = cursor;
    cursor++;
    while (cursor < messages.length && messages[cursor]?.role !== 'user') cursor++;
    if (cursor >= messages.length) break;
    const end = cursor;
    for (let index = start; index < end; index++) {
      const message = messages[index];
      if (message) size.remove(message);
    }
    cut = end;
    trims++;
    changed = true;
  }

  if (cut > first) {
    const dropped = messages.slice(first, cut);
    messages.splice(first, cut - first);
    if (trims > 0) noteTrimmed(messages, size, dropped);
  }

  return changed;
}

/**
 * The note goes on the leading system prompt rather than in a new system
 * message: OpenAI-compatible providers reject system messages mid-transcript.
 */
function noteTrimmed(messages: Message[], size: TranscriptSize, dropped: Message[] = []): void {
  const files = new Set<string>();
  let intent = '';
  for (const m of dropped) {
    if (m.role === 'user' && intent === '') intent = m.content.slice(0, 160);
    if (m.role === 'assistant') for (const c of m.toolCalls) {
      const p = (c.args as Record<string, unknown>).path;
      if (typeof p === 'string') files.add(p);
    }
  }
  const extra = intent !== '' ? ` Goal was: ${intent}` : '';
  const flist = files.size > 0 ? ` Files: ${[...files].slice(0, 8).join(', ')}.` : '';
  const note = `${TRIMMED_NOTE}${extra}${flist}`;
  const head = messages[0];
  if (head?.role === 'system') {
    if (!head.content.includes(TRIMMED_NOTE)) size.setContent(head, `${head.content}\n\n${note}`);
    return;
  }
  const sysnote = { role: 'system' as const, content: note };
  messages.unshift(sysnote);
  size.add(sysnote);
}

/**
 * Every assistant tool call must be followed by a tool result or the next
 * request is rejected. Interrupts and early exits can leave gaps; fill them in.
 * Returns the number of results inserted.
 */
export function repairToolCalls(messages: Message[]): number {
  // Results that exist anywhere already answer their call. Inserting a second
  // copy for a result that is merely not adjacent would duplicate tool_call_id.
  const answered = new Set<string>();
  for (const message of messages) {
    if (message.role === 'tool') answered.add(message.toolCallId);
  }

  let repaired = 0;

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message?.role !== 'assistant' || message.toolCalls.length === 0) continue;

    const missing = message.toolCalls.filter((call) => !answered.has(call.id));
    if (missing.length === 0) continue;

    let cursor = index + 1;
    while (cursor < messages.length && messages[cursor]?.role === 'tool') cursor++;

    const inserted: ToolMessage[] = missing.map((call) => ({
      role: 'tool',
      toolCallId: call.id,
      name: call.name,
      content: 'No result was recorded for this tool call — it was interrupted before it finished.',
      isError: true,
    }));
    messages.splice(cursor, 0, ...inserted);
    for (const call of missing) answered.add(call.id);
    repaired += inserted.length;
    index = cursor + inserted.length - 1;
  }

  return repaired;
}

export function isOverBudget(messages: Message[], budget: number): boolean {
  return estimateTokens(messages) > budget;
}

export const CONTEXT_NOTES = { ELIDED, TRIMMED_NOTE };
