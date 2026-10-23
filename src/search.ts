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
 *
 * If nothing matches literally, the query is retried once with one-edit
 * tolerance (a missing/extra letter, a substitution, or two swapped letters)
 * so a typo still finds the chat. Those hits are marked as near matches.
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
  /** Weighted term coverage: exact terms count 1, near matches count 0.5. */
  score: number;
  /** Total occurrences in this message. */
  count: number;
  /** Words the typo-tolerant fallback actually matched, so the UI can mark them. */
  near?: string[];
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
/** Typos are only worth guessing at for word-like terms this long. */
const FUZZY_MIN_LENGTH = 5;
/** A near match ranks below an exact one, and only runs when nothing matched. */
const FUZZY_WEIGHT = 0.5;
/** Bound the fallback scan so a huge tool dump cannot stall a keystroke. */
const MAX_FUZZY_CHARS = 50_000;
const MAX_FUZZY_WORDS = 4_000;
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

function snippetAround(text: string, at: number): string {
  if (at < 0) return text.slice(0, SNIPPET_BEFORE + SNIPPET_AFTER).trim();
  const start = Math.max(0, at - SNIPPET_BEFORE);
  const end = Math.min(text.length, at + SNIPPET_AFTER);
  // Collapse newlines so a hit inside a tool dump stays on one readable line.
  const body = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${body}${end < text.length ? '…' : ''}`;
}

/** Word-like terms only: `src/x.ts` and `--flag` keep their literal meaning. */
function termIsFuzzyEligible(term: string): boolean {
  return term.length >= FUZZY_MIN_LENGTH && /^[\p{L}\p{N}_]+$/u.test(term);
}

/**
 * True when `a` and `b` differ by one insertion, deletion, substitution, or
 * adjacent transposition ("recieve" → "receive"). One edit catches the typos
 * people actually make without turning short common words into matches.
 */
function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0;
  while (i < la && i < lb && a[i] === b[i]) i += 1;
  if (la === lb) {
    if (a.slice(i + 1) === b.slice(i + 1)) return true;
    return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2);
  }
  // One insertion/deletion: skip the extra character in the longer string.
  return la > lb ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

interface Word {
  text: string;
  at: number;
}

/** Lowercased words and their offsets, capped so a giant dump stays cheap. */
function wordsOf(text: string): Word[] {
  const scope = text.length > MAX_FUZZY_CHARS ? text.slice(0, MAX_FUZZY_CHARS) : text;
  const words: Word[] = [];
  for (const match of scope.matchAll(/[\p{L}\p{N}_]+/gu)) {
    words.push({ text: match[0].toLowerCase(), at: match.index ?? 0 });
    if (words.length >= MAX_FUZZY_WORDS) break;
  }
  return words;
}

/** True when the chat itself is filtered out by `chat:`/`project:` terms. */
function chatMatches(query: SearchQuery, chat: Searchable): boolean {
  const title = chat.title.toLowerCase();
  const project = chat.project.toLowerCase();
  if (!query.title.every((term) => title.includes(term))) return false;
  if (!query.project.every((term) => project.includes(term))) return false;
  return true;
}

/**
 * Matches one transcript. Returns hits in transcript order. `tolerant` retries
 * a term that has no literal occurrence as a one-edit near match; the caller
 * (searchChats) only turns it on when the whole query matched nothing exactly.
 */
export function searchMessages(query: SearchQuery, chat: Searchable, tolerant = false): SearchHit[] {
  if (isEmptyQuery(query) || !chatMatches(query, chat)) return [];

  // A quoted phrase keeps its literal meaning: guessing which words inside it
  // were swapped would be worse than returning nothing.
  const hints: { text: string; tolerant: boolean }[] = [
    ...query.terms.map((text) => ({ text, tolerant: true })),
    ...query.phrases.map((text) => ({ text, tolerant: false })),
  ];
  const hits: SearchHit[] = [];
  let index = 0;

  for (const message of chat.messages) {
    if (message.role === 'system') continue;
    index += 1;
    if (query.roles.length > 0 && !query.roles.includes(message.role)) continue;

    const text = messageText(message);
    if (text === '') continue;
    const lower = text.toLowerCase();
    let words: Word[] | null = null;
    const nearMatch = (term: string): Word | null => {
      if (!termIsFuzzyEligible(term)) return null;
      words ??= wordsOf(text);
      for (const word of words) {
        if (Math.abs(word.text.length - term.length) > 1) continue;
        if (withinOneEdit(word.text, term)) return word;
      }
      return null;
    };

    let score = 0;
    let occurrences = 0;
    let at = -1;
    const near: string[] = [];
    let matched = true;
    for (const hint of hints) {
      const found = count(lower, hint.text);
      if (found > 0) {
        score += 1;
        occurrences += found;
        const first = lower.indexOf(hint.text);
        if (first >= 0) at = at < 0 ? first : Math.min(at, first);
        continue;
      }
      const fuzzy = tolerant && hint.tolerant ? nearMatch(hint.text) : null;
      if (!fuzzy) {
        matched = false;
        break;
      }
      score += FUZZY_WEIGHT;
      occurrences += 1;
      near.push(fuzzy.text);
      at = at < 0 ? fuzzy.at : Math.min(at, fuzzy.at);
    }
    if (!matched) continue;
    if (query.excluded.some((term) => lower.includes(term))) continue;

    hits.push({
      index: index - 1,
      role: message.role,
      tool: message.role === 'tool' ? message.name : undefined,
      snippet: snippetAround(text, at),
      score,
      count: occurrences,
      ...(near.length > 0 ? { near } : {}),
    });
  }

  return hits;
}

/**
 * Searches many chats and ranks them: how much of the query a hit covers first,
 * then how recent the chat is. `limit` caps the hits returned; `truncated` says
 * whether anything was left out, so the window can tell the user.
 */
interface Collected {
  results: SearchResult[];
  truncated: boolean;
  chatsScanned: number;
}

function collect(
  query: SearchQuery,
  chats: { id: string; title: string; project: string; updatedAt: string; messages: Message[] }[],
  max: number,
  tolerant: boolean,
): Collected {
  const results: SearchResult[] = [];
  let truncated = false;

  for (const chat of chats) {
    const hits = searchMessages(
      query,
      { messages: chat.messages, title: chat.title, project: chat.project },
      tolerant,
    );
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
  return { results, truncated, chatsScanned: chats.length };
}

export function searchChats(
  raw: string,
  chats: { id: string; title: string; project: string; updatedAt: string; messages: Message[] }[],
  limit = 50,
): { query: SearchQuery; results: SearchResult[]; truncated: boolean; chatsScanned: number; fuzzy: boolean } {
  const query = parseQuery(raw);
  if (isEmptyQuery(query)) {
    return { query, results: [], truncated: false, chatsScanned: 0, fuzzy: false };
  }

  const max = Math.max(1, Math.min(200, Math.floor(limit)));
  // Literal first: a query that matches needs no guessing, and a correct search
  // never fills up with "best ≈ test" noise. Only zero literal hits fall back.
  const exact = collect(query, chats, max, false);
  if (exact.results.length > 0 || !query.terms.some((term) => termIsFuzzyEligible(term))) {
    return { query, ...exact, fuzzy: false };
  }
  const near = collect(query, chats, max, true);
  return { query, ...near, fuzzy: near.results.length > 0 };
}
