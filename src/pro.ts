import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Message } from './types.ts';
import type { AuditEvent } from './audit.ts';

/**
 * Pro utilities: small, dependency-free helpers that turn the existing
 * audit / checkpoint / session machinery into reviewable artifacts.
 * Everything here is best-effort and never throws into a turn.
 */

export function filterAudit(entries: AuditEvent[], query: string): AuditEvent[] {
  const q = query.trim().toLowerCase();
  if (q === '') return entries;
  return entries.filter((entry) => {
    const hay = `${String(entry.tool ?? '')} ${String(entry.event ?? '')} ${String(entry.args ?? '')} ${String(entry.error ?? '')}`.toLowerCase();
    return q.split(/\s+/).every((term) => hay.includes(term));
  });
}

export function formatAuditLine(entry: AuditEvent): string {
  const when = String(entry.at ?? '').replace('T', ' ').replace(/\..*$/, '');
  const status = entry.ok === false ? 'failed' : 'ok';
  const tool = String(entry.tool ?? entry.event ?? 'event');
  const agent = String(entry.agent ?? 'main');
  const extra = entry.error ? ` — ${String(entry.error).slice(0, 160)}` : '';
  return `${when} ${agent} ${tool} ${status}${extra}`;
}

/** Render a transcript as Markdown or JSON for review / handoff. */
export function exportSession(messages: Message[], format: 'md' | 'json'): string {
  if (format === 'json') return `${JSON.stringify(messages, null, 2)}\n`;
  const lines: string[] = ['# Session export', ''];
  for (const message of messages) {
    if (message.role === 'system') {
      lines.push('## System', '', message.content, '');
    } else if (message.role === 'user') {
      lines.push('## User', '', message.content, '');
    } else if (message.role === 'assistant') {
      lines.push('## Assistant', '', message.content || '(no text)', '');
      for (const call of message.toolCalls) {
        lines.push(`- tool \`${call.name}\` (${call.id}): \`${JSON.stringify(call.args).slice(0, 300)}\``);
      }
      if (message.toolCalls.length > 0) lines.push('');
    } else {
      const label = message.isError ? 'Tool (error)' : 'Tool';
      lines.push(`## ${label} — ${message.name}`, '', message.content.slice(0, 4000), '');
    }
  }
  return `${lines.join('\n')}\n`;
}

export function exportPathFor(workspace: string, format: 'md' | 'json'): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  try {
    mkdirSync(join(workspace, '.vaelen', 'exports'), { recursive: true });
  } catch {
    // Read-only workspace: caller reports the path; writeExport degrades gracefully.
  }
  return join(workspace, '.vaelen', 'exports', `${stamp}.${format === 'md' ? 'md' : 'json'}`);
}

export function writeAuditExport(workspace: string, entries: AuditEvent[]): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  try { mkdirSync(join(workspace, '.vaelen', 'exports'), { recursive: true }); } catch { /* best-effort */ }
  const path = join(workspace, '.vaelen', 'exports', `audit-${stamp}.jsonl`);
  try { writeFileSync(path, `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`, 'utf8'); } catch { /* best-effort */ }
  return path;
}

export function writeExport(workspace: string, messages: Message[], format: 'md' | 'json'): string {
  const path = exportPathFor(workspace, format);
  try {
    writeFileSync(path, exportSession(messages, format), 'utf8');
  } catch {
    // Export is best-effort; caller reports the path either way.
  }
  return path;
}

export interface CompactReport {
  before: number;
  after: number;
  saved: number;
  changed: boolean;
}

export function compactReport(before: number, after: number, changed: boolean): CompactReport {
  return { before, after, saved: Math.max(0, before - after), changed };
}

/** One-line E-drive bench sample: {label, ms, ops, opsPerSec}. */
export interface BenchSample {
  label: string;
  ms: number;
  ops: number;
  opsPerSec: number;
}

export function benchSample(label: string, ms: number, ops: number): BenchSample {
  const safeMs = Math.max(1, Math.round(ms));
  return { label, ms: safeMs, ops, opsPerSec: Math.round((ops / safeMs) * 1000) };
}

export function formatBench(samples: BenchSample[]): string {
  const lines = ['E-drive stress results:'];
  for (const sample of samples) {
    lines.push(`- ${sample.label}: ${sample.ops} ops in ${sample.ms}ms (${sample.opsPerSec.toLocaleString()} ops/s)`);
  }
  return lines.join('\n');
}
