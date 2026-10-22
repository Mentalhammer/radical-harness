export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

export function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ToolError(`Missing required string argument "${key}"`);
  }
  return value;
}

export function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

export function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}

export function optionalBoolean(args: Record<string, unknown>, key: string): boolean {
  return args[key] === true || args[key] === 'true';
}

export const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.vaelen', '.hg', '.svn', 'dist', 'build', 'out', '.next',
  '.nuxt', '.svelte-kit', 'target', 'vendor', '__pycache__', '.venv', 'venv', 'coverage',
  '.idea', '.vscode', '.turbo', '.cache', 'Pods', 'DerivedData',
]);

export const MAX_TOOL_OUTPUT = 24_000;

export function truncate(text: string, limit = MAX_TOOL_OUTPUT): string {
  if (text.length <= limit) return text;
  const head = text.slice(0, Math.floor(limit * 0.7));
  const tail = text.slice(-Math.floor(limit * 0.2));
  const omitted = text.length - head.length - tail.length;
  return `${head}\n… [${omitted.toLocaleString()} of ${text.length.toLocaleString()} chars omitted] …\n${tail}`;
}

/** Tiny unified diff for preview output (capped, no deps). */
export function unifiedDiff(before: string, after: string, maxLines = 120): string {
  const a = before.split('\n');
  const b = after.split('\n');
  // Simple LCS-free approach: find common prefix/suffix, show middle.
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const del = a.slice(pre, a.length - suf);
  const add = b.slice(pre, b.length - suf);
  const out: string[] = [];
  const ctxStart = Math.max(0, pre - 3);
  for (let i = ctxStart; i < pre; i++) out.push(` ${a[i]}`);
  for (const l of del) out.push(`-${l}`);
  for (const l of add) out.push(`+${l}`);
  const tailStart = b.length - suf;
  for (let i = tailStart; i < Math.min(b.length, tailStart + 3); i++) out.push(` ${b[i]}`);
  if (pre === a.length && pre === b.length) return '(no changes)';
  const head = `@@ -${pre + 1},${del.length} +${pre + 1},${add.length} @@`;
  const lines = [head, ...out];
  if (lines.length > maxLines) return [...lines.slice(0, maxLines), `… (${lines.length - maxLines} more diff lines)`].join('\n');
  return lines.join('\n');
}

export function relativePath(workspace: string, absolute: string): string {
  const rel = absolute.startsWith(workspace) ? absolute.slice(workspace.length) : absolute;
  return rel.replace(/^[\\/]+/, '').replace(/\\/g, '/') || '.';
}
