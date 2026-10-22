import type { ToolSpec } from '../types.ts';
import { askUserTool } from './ask.ts';
import { bashTool } from './bash.ts';
import { editFileTool, globTool, grepTool, listDirectoryTool, readFileTool, writeFileTool } from './fs.ts';
import { applyPatchTool } from './patch.ts';
import { repoMapTool } from './repomap.ts';
import { validateJsonTool } from './schema.ts';
import { taskTool } from './task.ts';
import { toonTool } from './toon.ts';

const tools: ToolSpec[] = [
  readFileTool,
  writeFileTool,
  editFileTool,
  applyPatchTool,
  listDirectoryTool,
  globTool,
  grepTool,
  repoMapTool,
  askUserTool,
  validateJsonTool,
  toonTool,
  bashTool,
  taskTool,
];

export const toolByName = new Map(tools.map((tool) => [tool.name, tool]));

/**
 * MCP servers register their tools after connecting. The provider schema, the
 * prompt's tool list, and permissions all read from this one array, so a late
 * registration is visible to the next request without rebuilding anything.
 */
export function registerTools(extra: ToolSpec[]): void {
  for (const tool of extra) {
    if (toolByName.has(tool.name)) continue;
    tools.push(tool);
    toolByName.set(tool.name, tool);
  }
}

/**
 * Read-only mode advertises only inspection tools, so the model does not plan
 * edits it cannot make. When questions are off (Auto), ask_user is hidden so
 * the model proceeds with its best guess instead of pausing for input.
 */
export function toolsFor(readOnly: boolean, allowQuestions = true): ToolSpec[] {
  const visible = readOnly ? tools.filter((tool) => tool.readOnly) : tools;
  return allowQuestions ? visible : visible.filter((tool) => tool.name !== 'ask_user');
}

export { tools };
