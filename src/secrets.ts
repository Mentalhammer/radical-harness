import { readFileConfig } from './config.ts';

/**
 * Credentials must never reach the transcript, the session log, the audit log,
 * or the window. `cat ~/.vaelen/config.json` is a legitimate thing for the model
 * to try, so the guard is mechanical rather than a prompt instruction: every
 * string that leaves a tool is scrubbed here first.
 */
export const REDACTED = '[redacted-key]';

/** Shorter values are too likely to appear in ordinary text to replace safely. */
const MIN_LITERAL = 8;

const ENV_KEYS = ['VAELEN_API_KEY', 'DEEPSEEK_API_KEY', 'OPENAI_API_KEY'];

/** The config file is read at most once per window, not once per string. */
const CACHE_MS = 2_000;

const PATTERNS: { re: RegExp; replace: string }[] = [
  // Provider and platform key shapes, matched even when the key is unknown to us.
  { re: /\b(?:sk|rk)-[A-Za-z0-9_-]{16,}/g, replace: REDACTED },
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g, replace: REDACTED },
  { re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, replace: REDACTED },
  { re: /\bAKIA[0-9A-Z]{16,}/g, replace: REDACTED },
  { re: /\bAIza[0-9A-Za-z_-]{30,}/g, replace: REDACTED },
  { re: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/g, replace: `Bearer ${REDACTED}` },
  // Basic/Digest credentials are base64 blobs; keep the scheme, drop the value.
  { re: /\b(Basic|Digest|Token)\s+[A-Za-z0-9+/=._~-]{12,}/g, replace: `$1 ${REDACTED}` },
  // JSON and .env assignments: "apiKey": "...", DEEPSEEK_API_KEY=..., token: '...'
  // An auth scheme value ("Bearer …") is skipped here so the scheme line keeps its
  // shape and the token itself is caught by the Bearer pattern above.
  // The value must contain something other than letters, so ordinary code such as
  // `payload.apiKey = apiKey;` survives a read_file instead of becoming "[redacted-key]".
  {
    re: /(api[_-]?key|apikey|secret|password|passwd|token|authorization)(["']?\s*[:=]\s*["']?)(?!(?:bearer|basic|token)\s)(?=[^\s"',;]*[0-9._~+/=-])[^\s"',;]{6,}/gi,
    replace: `$1$2${REDACTED}`,
  },
];

let cache: { at: number; values: string[] } | undefined;

/** Key values this machine actually holds, so they are scrubbed even if unshaped. */
function configuredSecrets(): string[] {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_MS) return cache.values;

  const values: string[] = [];
  for (const name of ENV_KEYS) {
    const value = process.env[name]?.trim();
    if (value !== undefined && value.length >= MIN_LITERAL) values.push(value);
  }
  try {
    // The same file `cat` would print: the value the user pasted at setup.
    const apiKey = readFileConfig().apiKey?.trim();
    if (apiKey !== undefined && apiKey.length >= MIN_LITERAL) values.push(apiKey);
  } catch {
    // An unreadable config is not a reason to leak the rest.
  }

  const unique = [...new Set(values)];
  cache = { at: now, values: unique };
  return unique;
}

/**
 * One cheap scan decides whether the eight patterns are worth running. Audit
 * events and tool results are written constantly, and the stress test shows the
 * difference: without this gate 1,000 appends cost 2.6s instead of 0.9s.
 */
const MAYBE_SECRET =
  /sk-|rk-|gh[pousr]_|xox[abprs]-|AKIA|AIza|Bearer|Basic|Digest|Token|api[_-]?key|apikey|secret|passwd|password|token|authorization/i;

function scrub(text: string, literals: string[]): string {
  let out = text;
  for (const secret of literals) {
    if (out.includes(secret)) out = out.split(secret).join(REDACTED);
  }
  if (!MAYBE_SECRET.test(out)) return out;
  for (const { re, replace } of PATTERNS) out = out.replace(re, replace);
  return out;
}

export function redactSecrets(text: string): string {
  if (text === '') return text;
  return scrub(text, configuredSecrets());
}

/**
 * Walks a tool-call argument object so nested strings are scrubbed too. The
 * known-secret list is resolved once here: a long audit event or transcript
 * message must not pay a config read per string.
 */
export function redactValue<T>(value: T): T {
  const literals = configuredSecrets();
  const walk = (item: unknown): unknown => {
    if (typeof item === 'string') return scrub(item, literals);
    if (Array.isArray(item)) return item.map(walk);
    if (typeof item === 'object' && item !== null) {
      const copy: Record<string, unknown> = {};
      for (const [key, nested] of Object.entries(item as Record<string, unknown>)) copy[key] = walk(nested);
      return copy;
    }
    return item;
  };
  return walk(value) as T;
}

/** Tests change the config file under the cache; this drops it. */
export function resetSecretCache(): void {
  cache = undefined;
}
