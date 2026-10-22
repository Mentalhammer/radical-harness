import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Project instructions, in the order most coding agents already look for them.
 * They are appended to the system prompt, so a repo can carry its conventions
 * without the user re-explaining them every session.
 */
const RULE_FILES = [
  'AGENTS.md',
  'CLAUDE.md',
  '.vaelen/rules.md',
  '.cursorrules',
  '.github/copilot-instructions.md',
];

const MAX_FILE_CHARS = 16_000;
const MAX_TOTAL_CHARS = 24_000;

export interface ProjectRules {
  files: string[];
  text: string;
  truncated: boolean;
}

export function loadProjectRules(workspace: string, files = RULE_FILES): ProjectRules {
  const sections: string[] = [];
  const loaded: string[] = [];
  let total = 0;
  let truncated = false;

  for (const relative of files) {
    const path = join(workspace, relative);
    if (!existsSync(path)) continue;
    const info = statSync(path, { throwIfNoEntry: false });
    if (!info?.isFile()) continue;
    let content: string;
    try {
      content = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    if (content.includes('\u0000')) continue;

    const room = MAX_TOTAL_CHARS - total;
    if (room <= 0) {
      truncated = true;
      break;
    }
    const clipped = content.length > Math.min(MAX_FILE_CHARS, room)
      ? `${content.slice(0, Math.min(MAX_FILE_CHARS, room))}\n… [truncated]`
      : content;
    if (clipped.length < content.length) truncated = true;
    loaded.push(relative);
    total += clipped.length;
    sections.push(`--- ${relative} ---\n${clipped.trim()}`);
  }

  return {
    files: loaded,
    text: sections.join('\n\n'),
    truncated,
  };
}

export function rulesPrompt(workspace: string): string {
  const rules = loadProjectRules(workspace);
  if (rules.files.length === 0) return '';
  const note = rules.truncated ? '\n[Some project instructions were truncated to fit the prompt.]' : '';
  return `\n\nProject instructions (${rules.files.join(', ')}). Follow them when they do not conflict with the user's request:\n${rules.text}${note}`;
}
