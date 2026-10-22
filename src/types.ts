export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface SystemMessage {
  role: 'system';
  content: string;
}

export type AttachmentKind = 'image' | 'text';

/** Text attachments are cut at this length before they reach the provider. */
export const MAX_ATTACHMENT_CHARS = 40_000;

/**
 * An attachment belongs to one user message. Text content lives in the message;
 * images are saved under `.vaelen/attachments/` and referenced by `file`.
 */
export interface Attachment {
  id: string;
  name: string;
  kind: AttachmentKind;
  mime: string;
  size: number;
  /** Text attachments only. */
  content?: string;
  /** Workspace-relative path for image attachments. */
  file?: string;
}

export interface UserMessage {
  role: 'user';
  content: string;
  attachments?: Attachment[];
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  /** Present when the model emitted unparseable JSON arguments. */
  rawArgs?: string;
}

export interface AssistantMessage {
  role: 'assistant';
  content: string;
  toolCalls: ToolCall[];
}

export interface ToolMessage {
  role: 'tool';
  toolCallId: string;
  name: string;
  content: string;
  isError?: boolean;
}

export type Message = SystemMessage | UserMessage | AssistantMessage | ToolMessage;

export interface JsonSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolOutcome {
  content: string;
  isError?: boolean;
  /** True when the tool changed the workspace (drives verification and audit). */
  mutated?: boolean;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: JsonSchema;
  /** Read-only tools never prompt for approval and are safe to run in parallel. */
  readOnly: boolean;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome>;
}

/** A question the model wants the user to answer. */
export interface QuestionRequest {
  question: string;
  /** Empty for a free-form answer. */
  options: string[];
}

export interface ToolContext {
  workspace: string;
  signal: AbortSignal;
  permissions: import('./permissions.ts').Permissions;
  /** The resolved session config; tools that need model or verify settings read it here. */
  config?: import('./config.ts').Config;
  /** Per-run undo journal; mutating tools snapshot before they write. */
  checkpoints?: import('./checkpoints.ts').CheckpointBatch;
  /** Streams partial command output to the UI (bash). */
  onOutput?: (chunk: string) => void;
  /** Asks the user a question; resolves null when there is no channel or the turn was interrupted. */
  ask?: (request: QuestionRequest) => Promise<string | null>;
  /** Runs an isolated child agent. Absent in subagents and one-shot runs without one. */
  subagent?: (request: SubagentRequest) => Promise<ToolOutcome>;
  /** "main" or "subagent:<n>"; recorded in the audit log. */
  agent?: string;
}

/** A self-contained task delegated to a child agent with its own context. */
export interface SubagentRequest {
  prompt: string;
  description?: string;
  /** "read" (default) only inspects; "edit" may change the workspace. */
  mode?: 'read' | 'edit';
  /** Restrict the child to these tool names. */
  tools?: string[];
  model?: string;
  max_steps?: number;
}

/** Token counts for one model request, as reported by the provider. */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** True when the provider sent no usage block and these are local estimates. */
  estimated?: boolean;
}

export type ProviderEvent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'usage'; usage: TokenUsage }
  /**
   * `truncated` is set when the connection died before the provider said the
   * reply was finished (no finish_reason, no [DONE]): the text is only a prefix.
   */
  | { type: 'done'; finishReason: string | null; truncated?: boolean };
