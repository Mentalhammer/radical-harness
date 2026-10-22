import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { Config } from './config.ts';
import {
  MAX_ATTACHMENT_CHARS,
  type Attachment,
  type Message,
  type ProviderEvent,
  type TokenUsage,
  type ToolCall,
  type ToolSpec,
} from './types.ts';

export class ProviderError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
  }
}

interface WireToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface WireMessage {
  role: string;
  content: string | null | unknown[];
  tool_calls?: WireToolCall[];
  tool_call_id?: string;
}

function toWire(message: Message, config: Config): WireMessage {
  switch (message.role) {
    case 'user': {
      if (!message.attachments?.length) return { role: 'user', content: message.content };

      const textSections = [
        message.content,
        ...message.attachments.filter((item) => item.kind === 'text').map(attachmentText),
      ].filter((section) => section !== '');
      const images = message.attachments.filter((item) => item.kind === 'image');

      // Text-only attachments stay a plain string so text-only providers keep working.
      if (images.length === 0) {
        return { role: 'user', content: textSections.join('\n\n') };
      }

      const parts: unknown[] = textSections.map((text) => ({ type: 'text', text }));
      for (const image of images) {
        const url = imageDataUrl(image, config);
        if (url) {
          parts.push({ type: 'text', text: `[Attached image: ${safeName(image.name)}]` });
          parts.push({ type: 'image_url', image_url: { url } });
        } else {
          parts.push({ type: 'text', text: `[Image "${safeName(image.name)}" is no longer available]` });
        }
      }
      return { role: 'user', content: parts };
    }
    case 'assistant': {
      const wire: WireMessage = { role: 'assistant', content: message.content };
      if (message.toolCalls.length > 0) {
        wire.tool_calls = message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: {
            name: call.name,
            arguments: call.rawArgs ?? JSON.stringify(call.args),
          },
        }));
      }
      return wire;
    }
    case 'tool':
      return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
    default:
      return { role: message.role, content: message.content };
  }
}

function safeName(name: string): string {
  return name.replace(/[\r\n"]/g, ' ').slice(0, 120);
}

function attachmentText(attachment: Attachment): string {
  const raw = attachment.content ?? '';
  const body =
    raw.length > MAX_ATTACHMENT_CHARS
      ? `${raw.slice(0, MAX_ATTACHMENT_CHARS)}\n… [attachment truncated]`
      : raw;
  const name = safeName(attachment.name);
  return `--- Attached file: ${name} ---\n${body}\n--- End ${name} ---`;
}

const MAX_IMAGE_INLINE_BYTES = 8_000_000;

function imageDataUrl(attachment: Attachment, config: Config): string | undefined {
  if (!attachment.file) return undefined;
  const root = resolve(config.workspace, '.vaelen', 'attachments');
  const absolute = resolve(config.workspace, attachment.file);
  const rel = relative(root, absolute);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return undefined;
  try {
    const info = statSync(absolute, { throwIfNoEntry: false });
    if (!info?.isFile() || info.size > MAX_IMAGE_INLINE_BYTES) return undefined;
    return `data:${attachment.mime};base64,${readFileSync(absolute).toString('base64')}`;
  } catch {
    return undefined;
  }
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (typeof part === 'object' && part !== null && 'text' in part) {
          const text = (part as { text: unknown }).text;
          return typeof text === 'string' ? text : '';
        }
        return '';
      })
      .join('');
  }
  return '';
}

function parseArgs(raw: string): Pick<ToolCall, 'args' | 'rawArgs'> {
  if (raw.trim() === '') return { args: {} };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return { args: parsed as Record<string, unknown> };
    }
    return { args: {}, rawArgs: raw };
  } catch {
    return { args: {}, rawArgs: raw };
  }
}

const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 30_000;
/**
 * How long the provider may stay silent before the request is treated as dead.
 * It covers the wait for the first byte — a 200k-token prompt can take minutes
 * to prefill — as well as the gaps between stream chunks.
 */
const DEFAULT_TIMEOUT_MS = 300_000;
/** A single SSE frame larger than this is a broken or hostile stream. */
const MAX_SSE_BUFFER = 2_000_000;

/** Overridable so tests (and very slow local models) can tune it. */
function requestTimeoutMs(): number {
  const raw = Number(process.env.VAELEN_REQUEST_TIMEOUT_MS);
  return Number.isFinite(raw) && raw >= 50 ? raw : DEFAULT_TIMEOUT_MS;
}
/** Transient: rate limits, timeouts, and server-side failures are worth retrying. */
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

/** Streams an OpenAI-compatible /chat/completions response. */
export async function* streamChat(
  config: Config,
  messages: Message[],
  tools: ToolSpec[],
  signal: AbortSignal,
): AsyncGenerator<ProviderEvent> {
  const body: Record<string, unknown> = {
    model: config.model,
    messages: messages.map((message) => toWire(message, config)),
    stream: true,
  };
  // DeepSeek and OpenAI send token counts on the final stream chunk only when
  // asked. Other OpenAI-compatible servers may reject the field, so it stays
  // off there; their usage is still read if they volunteer it.
  if (supportsStreamUsage(config.baseUrl)) body.stream_options = { include_usage: true };
  if (tools.length > 0) {
    body.tools = tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }

  let response: Response;
  try {
    response = await postChat(config, body, signal);
  } catch (error) {
    // One fallback attempt with a different model on rate-limit/server errors.
    const fallback = config.fallbackModel?.trim();
    const retryable =
      error instanceof ProviderError &&
      typeof error.status === 'number' && RETRYABLE_STATUS.has(error.status);
    if (!retryable || !fallback || fallback === config.model) throw error;
    const fallbackBody = { ...body, model: fallback };
    response = await postChat(config, fallbackBody, signal);
  }
  const contentType = response.headers.get('content-type') ?? '';

  // Some local servers ignore stream:true and return a plain JSON body.
  if (contentType.includes('application/json')) {
    const payload = (await withTimeout(
      response.json(),
      requestTimeoutMs(),
      'The provider accepted the request but never sent a body',
    )) as {
      choices?: { message?: { content?: unknown; tool_calls?: RawToolCall[] }; finish_reason?: string }[];
      usage?: unknown;
    };
    const choice = payload.choices?.[0];
    const text = textOf(choice?.message?.content);
    const calls = normalizeCalls(choice?.message?.tool_calls);
    const finish = choice?.finish_reason ?? null;
    // A 200 that carries nothing is a gateway error, not an empty answer: fail
    // loudly instead of ending the turn as if the model had replied.
    if (text === '' && calls.length === 0 && finish === null) {
      throw new ProviderError('The provider returned an empty reply (no text, no tool calls, no finish reason).');
    }
    if (text) yield { type: 'text', text };
    for (const call of calls) yield { type: 'tool_call', call };
    const usage = readUsage(payload.usage);
    if (usage) yield { type: 'usage', usage };
    yield { type: 'done', finishReason: finish };
    return;
  }

  if (!response.body) throw new ProviderError('Provider returned an empty response body');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const pending = new Map<number, { id: string; name: string; args: string }>();
  let buffer = '';
  let finishReason: string | null = null;
  let yieldedUsage: TokenUsage | undefined;
  /** Any delta at all: content, reasoning, or a tool-call fragment. */
  let produced = false;
  /** The provider sent its end-of-stream marker. */
  let sawDone = false;

  const takeCalls = (): ToolCall[] => {
    const calls = [...pending.entries()]
      .sort(([a], [b]) => a - b)
      .filter(([, slot]) => slot.name !== '')
      .map(([index, slot]) => ({
        id: slot.id || `call_${randomUUID()}_${index}`,
        name: slot.name,
        ...parseArgs(slot.args),
      }));
    pending.clear();
    return calls;
  };

  while (true) {
    let chunk: ReadResult;
    try {
      chunk = await readWithTimeout(reader, requestTimeoutMs());
    } catch (error) {
      // Release the socket so a dead provider cannot pin the process.
      void reader.cancel().catch(() => undefined);
      throw error;
    }
    const { value, done } = chunk;
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    if (buffer.length > MAX_SSE_BUFFER) {
      throw new ProviderError(
        `The provider sent a stream frame larger than ${MAX_SSE_BUFFER.toLocaleString()} characters.`,
      );
    }

    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');

      if (line === '' || line.startsWith(':')) continue;
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') {
        sawDone = true;
        continue;
      }

      let chunk: RawChunk;
      try {
        chunk = JSON.parse(data) as RawChunk;
      } catch {
        continue;
      }

      // The usage block arrives on its own chunk with an empty choices array.
      const usage = readUsage(chunk.usage);
      if (usage) yieldedUsage = usage;

      const choice = chunk.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;

      const delta = (choice.delta ?? {}) as Record<string, unknown> & {
        reasoning_content?: unknown;
        reasoning?: unknown;
      };
      const text = textOf(delta.content);
      if (text) {
        produced = true;
        yield { type: 'text', text };
      }
      const reasoning = textOf(delta.reasoning_content) || textOf(delta.reasoning);
      if (reasoning) {
        produced = true;
        yield { type: 'reasoning', text: reasoning };
      }

      if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
        produced = true;
        for (const fragment of delta.tool_calls) {
          const index = typeof fragment.index === 'number' ? fragment.index : 0;
          let slot = pending.get(index);
          if (!slot) {
            slot = { id: '', name: '', args: '' };
            pending.set(index, slot);
          }
          if (fragment.id) slot.id = fragment.id;
          const name = fragment.function?.name;
          if (typeof name === 'string' && name.length > 0) {
            // Names stream in fragments, but some servers repeat the whole name
            // on every chunk. Appending blindly would produce "read_fileread_file".
            if (slot.name === '') slot.name = name;
            else if (name !== slot.name) slot.name = name.startsWith(slot.name) ? name : slot.name + name;
          }
          const args = fragment.function?.arguments;
          if (typeof args === 'string') slot.args += args;
        }
      }
    }
  }

  const calls = takeCalls();
  if (!produced && finishReason === null && calls.length === 0) {
    throw new ProviderError('The provider returned an empty reply (no text, no tool calls, no finish reason).');
  }
  for (const call of calls) yield { type: 'tool_call', call };
  if (yieldedUsage) yield { type: 'usage', usage: yieldedUsage };
  // No finish_reason and no [DONE] means the connection died mid-reply: the
  // caller has to know the text it received is only a prefix.
  yield { type: 'done', finishReason, truncated: finishReason === null && !sawDone && produced };
}

/** Hosts whose streaming API understands `stream_options.include_usage`. */
function supportsStreamUsage(baseUrl: string): boolean {
  try {
    return /(^|\.)deepseek\.com|(^|\.)openai\.com/i.test(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}

function readUsage(raw: unknown): TokenUsage | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  const number = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;

  const prompt = number(record.prompt_tokens) ?? 0;
  const completion = number(record.completion_tokens) ?? 0;
  const total = number(record.total_tokens) ?? prompt + completion;
  if (prompt === 0 && completion === 0 && total === 0) return undefined;
  return { promptTokens: prompt, completionTokens: completion, totalTokens: total };
}

/**
 * POSTs the request, retrying transient failures with exponential backoff.
 * Safe to retry: nothing has been streamed to the caller yet.
 */
async function postChat(
  config: Config,
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Response> {
  let lastError: ProviderError | undefined;
  let delayMs = 0;

  let endpoint: URL;
  try {
    endpoint = new URL(`${config.baseUrl}/chat/completions`);
  } catch {
    throw new ProviderError(
      `Invalid base URL "${config.baseUrl}" — pass --base-url https://api.deepseek.com (or your server's /v1 URL).`,
    );
  }

  const timeoutMs = requestTimeoutMs();

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (delayMs > 0) await sleep(delayMs, signal);

    // Headers only: a long generation may legitimately stream past this, so
    // the timer is cleared as soon as the response arrives and the body is
    // then governed by the idle timeout instead.
    const controller = new AbortController();
    const forwardAbort = (): void => controller.abort();
    signal.addEventListener('abort', forwardAbort, { once: true });
    let timer: NodeJS.Timeout | undefined;
    let response: Response;
    try {
      response = await Promise.race([
        fetch(endpoint, {
          method: 'POST',
          headers: buildHeaders(config),
          body: JSON.stringify(body),
          signal: controller.signal,
        }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new ProviderError(`${config.baseUrl} did not answer within ${Math.round(timeoutMs / 1000)}s.`));
          }, timeoutMs);
          timer.unref();
        }),
      ]);
    } catch (error) {
      if (signal.aborted) throw error;
      const timedOut = error instanceof ProviderError && error.message.includes('did not answer');
      lastError = timedOut
        ? (error as ProviderError)
        : new ProviderError(`Could not reach ${config.baseUrl} — ${(error as Error).message}`);
      delayMs = backoff(attempt);
      continue;
    } finally {
      if (timer) clearTimeout(timer);
      signal.removeEventListener('abort', forwardAbort);
    }

    if (response.ok) return response;

    const detail = (await response.text().catch(() => '')).slice(0, 800).trim();
    lastError = new ProviderError(
      `Provider returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`,
      response.status,
    );
    if (!RETRYABLE_STATUS.has(response.status)) throw lastError;
    delayMs = retryDelay(response, attempt);
  }

  throw lastError ?? new ProviderError(`Could not reach ${config.baseUrl}`);
}

function buildHeaders(config: Config): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
  return headers;
}

function backoff(attempt: number): number {
  const delay = BASE_DELAY_MS * 2 ** (attempt - 1);
  // Jitter keeps concurrent sessions from retrying in lockstep.
  return Math.min(MAX_DELAY_MS, delay + Math.floor(Math.random() * 250));
}

function retryDelay(response: Response, attempt: number): number {
  const header = response.headers.get('retry-after');
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) {
      // A zero-second retry-after would hammer a rate-limited endpoint; floor it.
      return Math.min(MAX_DELAY_MS, Math.max(500, seconds * 1000));
    }
    const date = Date.parse(header);
    if (Number.isFinite(date)) {
      return Math.min(MAX_DELAY_MS, Math.max(0, date - Date.now()));
    }
  }
  return backoff(attempt);
}

interface ReadResult {
  done: boolean;
  value?: Uint8Array;
}

async function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  ms: number,
): Promise<ReadResult> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new ProviderError(`The provider stopped sending data for ${Math.round(ms / 1000)}s.`)),
          ms,
        );
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new ProviderError(message)), ms);
      timer.unref();
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function abortError(): Error {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

interface RawToolCall {
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface RawChunk {
  usage?: unknown;
  choices?: {
    delta?: {
      content?: unknown;
      tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[];
    };
    message?: { content?: unknown; tool_calls?: RawToolCall[] };
    finish_reason?: string | null;
  }[];
}

function normalizeCalls(calls: RawToolCall[] | undefined): ToolCall[] {
  if (!Array.isArray(calls)) return [];
  return calls
    // Matches the streaming path: a fragment that never carried a name is not
    // a tool call, it is noise from a broken server.
    .filter((call) => typeof call.function?.name === 'string' && call.function.name !== '')
    .map((call) => ({
      id: call.id ?? `call_${randomUUID()}`,
      name: call.function?.name ?? '',
      ...parseArgs(call.function?.arguments ?? ''),
    }));
}
