import type { Message } from './types.ts';

/**
 * Full-transcript search. Kept dependency-free and pure so it can be unit tested
 * and reused by the GUI: the caller supplies the messages, this decides what
 * matches and what snippet to show.
 *
 * Query syntax (all optional, combinable):
 *   words         every word must appear somewhere in the message (AND)
 *   "two words"   a phrase, matched verbatim
 *   -word         excluded
 *   role:user     only messages from that role (user, assistant, tool, or system —
 *                 a system prompt is never indexed, so role:system finds nothing)
 *   chat:build    only chats whose title contains "build"
 *   project:app   only chats whose folder contains "app"
 */
export interface SearchQuery {
  terms: string[];
  phrases: string[];
  excluded: string[];
  roles: string[];
  title: string[];
  project: string[];
}

export interface SearchHit {
  /** Index into the transcript, counting from the first non-system message. */
  index: number;
  role: Message['role'];
  /** Tool name for tool messages, so the UI can label where the hit came from. */
  tool?: string;
  /** Text around the first match, with the matched terms emphasised by the UI. */
  snippet: string;
  /** How many of the query's terms this message matched (higher is better). */
  score: number;
  /** Total occurrences in this message. */
  count: number;
}

export interface Searchable {
  messages: Message[];
  title: string;
  project: string;
}

export interface SearchResult extends SearchHit {
  chatId: string;
  chatTitle: string;
  project: string;
  updatedAt: string;
}

const SNIPPET_BEFORE = 60;
const SNIPPET_AFTER = 160;
// `system` is accepted so `role:system` filters everything out, which is the
// honest answer: the prompt is never indexed.
const ROLES = new Set(['user', 'assistant', 'tool', 'system']);

/** Splits a query into its parts. Unbalanced quotes are treated as plain words. */
export function parseQuery(raw: string): SearchQuery {
  const query: SearchQuery = { terms: [], phrases: [], excluded: [], roles: [], title: [], project: [] };
  const text = raw.trim();
  if (text === '') return query;

  const tokens = text.match(/-?"[^"]*"?|\S+/g) ?? [];
  for (const token of tokens) {
    if (token === '') continue;
    // A single leading `-` negates; `--flag` is a term to search for, because
    // command-line flags are exactly what people look for in a transcript.
    const negated = token.startsWith('-') && !token.startsWith('--') && token.length > 1;
    const body = negated ? token.slice(1) : token;

    const field = /^(role|chat|project):(.*)$/i.exec(body);
    if (field) {
      const value = (field[2] ?? '').replace(/^"|"$/g, '').toLowerCase();
      if (value !== '') {
        if (field[1]?.toLowerCase() === 'role') {
          // An unknown role would silently match nothing; ignore it instead.
          const roles = value.split(',').filter((role) => ROLES.has(role));
          if (roles.length > 0) query.roles.push(...roles);
        } else if (field[1]?.toLowerCase() === 'chat') {
          query.title.push(value);
        } else {
          query.project.push(value);
        }
      }
      continue;
    }

    const quoted = body.replace(/^"|"$/g, '');
    if (negated) query.excluded.push(quoted.toLowerCase());
    else if (quoted.includes(' ')) query.phrases.push(quoted.toLowerCase());
    else if (quoted !== '') query.terms.push(quoted.toLowerCase());
  }
  return query;
}

export function isEmptyQuery(query: SearchQuery): boolean {
  return (
    query.terms.length === 0 &&
    query.phrases.length === 0 &&
    query.roles.length === 0 &&
    query.title.length === 0 &&
    query.project.length === 0
  );
}

/** The text a message contributes: body plus tool arguments, so a command is findable. */
function messageText(message: Message): string {
  if (message.role === 'assistant' && message.toolCalls.length > 0) {
    const calls = message.toolCalls.map((call) => `${call.name} ${JSON.stringify(call.args)}`).join('\n');
    return message.content === '' ? calls : `${message.content}\n${calls}`;
  }
  if (message.role === 'user' && message.attachments !== undefined && message.attachments.length > 0) {
    const names = message.attachments.map((item) => item.name).join(' ');
    return `${message.content}\n${names}`;
  }
  return message.content;
}

function count(haystack: string, needle: string): number {
  if (needle === '') return 0;
  let total = 0;
  let index = haystack.indexOf(needle);
  while (index >= 0) {
    total += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return total;
}

function snippetAround(text: string, needles: string[]): string {
  const lower = text.toLowerCase();
  let at = -1;
  for (const needle of needles) {
    const found = lower.indexOf(needle);
    if (found >= 0 && (at === -1 || found < at)) at = found;
  }
  if (at === -1) return text.slice(0, SNIPPET_BEFORE + SNIPPET_AFTER).trim();

  const start = Math.max(0, at - SNIPPET_BEFORE);
  const end = Math.min(text.length, at + SNIPPET_AFTER);
  // Collapse newlines so a hit inside a tool dump stays on one readable line.
  const body = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${body}${end < text.length ? '…' : ''}`;
}

/** True when the chat itself is filtered out by `chat:`/`project:` terms. */
function chatMatches(query: SearchQuery, chat: Searchable): boolean {
  const title = chat.title.toLowerCase();
  const project = chat.project.toLowerCase();
  if (!query.title.every((term) => title.includes(term))) return false;
  if (!query.project.every((term) => project.includes(term))) return false;
  return true;
}

/** Matches one transcript. Returns hits in transcript order. */
export function searchMessages(query: SearchQuery, chat: Searchable): SearchHit[] {
  if (isEmptyQuery(query) || !chatMatches(query, chat)) return [];

  const hints = [...query.terms, ...query.phrases];
  const hits: SearchHit[] = [];
  let index = 0;

  for (const message of chat.messages) {
    if (message.role === 'system') continue;
    index += 1;
    if (query.roles.length > 0 && !query.roles.includes(message.role)) continue;

    const text = messageText(message);
    if (text === '') continue;
    const lower = text.toLowerCase();

    let score = 0;
    let occurrences = 0;
    let matched = true;
    for (const term of hints) {
      const found = count(lower, term);
      if (found === 0) {
        matched = false;
        break;
      }
      score += 1;
      occurrences += found;
    }
    if (!matched) continue;
    if (query.excluded.some((term) => lower.includes(term))) continue;

    hits.push({
      index: index - 1,
      role: message.role,
      tool: message.role === 'tool' ? message.name : undefined,
      snippet: snippetAround(text, hints.length > 0 ? hints : []),
      score,
      count: occurrences,
    });
  }

  return hits;
}

/**
 * Searches many chats and ranks them: how much of the query a hit covers first,
 * then how recent the chat is. `limit` caps the hits returned; `truncated` says
 * whether anything was left out, so the window can tell the user.
 */
export function searchChats(
  raw: string,
  chats: { id: string; title: string; project: string; updatedAt: string; messages: Message[] }[],
  limit = 50,
): { query: SearchQuery; results: SearchResult[]; truncated: boolean; chatsScanned: number } {
  const query = parseQuery(raw);
  const results: SearchResult[] = [];
  if (isEmptyQuery(query)) return { query, results, truncated: false, chatsScanned: 0 };

  const max = Math.max(1, Math.min(200, Math.floor(limit)));
  let truncated = false;

  for (const chat of chats) {
    const hits = searchMessages(query, { messages: chat.messages, title: chat.title, project: chat.project });
    for (const hit of hits) {
      if (results.length >= max) {
        truncated = true;
        break;
      }
      results.push({
        ...hit,
        chatId: chat.id,
        chatTitle: chat.title,
        project: chat.project,
        updatedAt: chat.updatedAt,
      });
    }
    if (truncated) break;
  }

  results.sort((a, b) => b.score - a.score || b.updatedAt.localeCompare(a.updatedAt) || a.index - b.index);
  return { query, results, truncated, chatsScanned: chats.length };
}
