import { randomUUID } from 'node:crypto';
import type { Config } from './config.ts';
import { defaultContextBudget, stepLimit } from './config.ts';
import { compact, estimateTokens, textTokens } from './context.ts';
import { AuditLog, auditPreview, loadHooks, runHook, type HookConfig } from './audit.ts';
import { CheckpointBatch } from './checkpoints.ts';
import { PermissionError, type Permissions } from './permissions.ts';
import { buildSystemPrompt } from './prompt.ts';
import { streamChat } from './provider.ts';
import type { Ui } from './render.ts';
import { redactSecrets } from './secrets.ts';
import type { Session } from './session.ts';
import { tools, toolByName, toolsFor } from './tools/index.ts';
import { truncate } from './tools/util.ts';
import { discoverChecks, runChecks } from './verify.ts';
import type {
  AssistantMessage,
  Message,
  SubagentRequest,
  ToolCall,
  ToolMessage,
  ToolOutcome,
  ToolSpec,
  TokenUsage,
  UserMessage,
  QuestionRequest,
} from './types.ts';

export type StopReason = 'complete' | 'max-steps' | 'aborted' | 'verify-failed' | 'repeat-loop';

export interface RunState {
  audit: AuditLog;
  checkpoints: CheckpointBatch;
  hooks: HookConfig;
  /** Set by any tool that changed the workspace; drives the verification pass. */
  mutated: boolean;
  subagents: number;
  verifyRuns: number;
}

export interface RunOptions {
  config: Config;
  permissions: Permissions;
  messages: Message[];
  ui: Ui;
  session?: Session;
  signal: AbortSignal;
  /** Called once per model request with the tokens that request consumed. */
  onUsage?: (usage: TokenUsage) => void | Promise<void>;
  /**
   * Guidance typed while the turn runs. It is drained at the top of each step,
   * where the transcript ends with a tool result or a finished reply, so it can
   * never split a tool call from its result.
   */
  steering?: { drain(): string[] };
  /** Asks the user a question; null when there is no channel or the turn was interrupted. */
  ask?: (request: QuestionRequest, signal: AbortSignal) => Promise<string | null>;
  /** Restricts the tool schema for a child agent (or a read-only run). */
  tools?: ToolSpec[];
  /** 0 for the user's agent, 1 for a subagent. */
  depth?: number;
  /** Shared by a parent and its subagents: one checkpoint, one audit log, one budget. */
  state?: RunState;
}

const SUBAGENT_NOTE = `

You are a subagent. Work only on the task in the user message; the parent agent cannot see your transcript, only your final report. Do not ask the user questions, do not start other subagents, and end with a concise report: what you found or changed, the files involved, and anything the parent still needs to do.`;

const MAX_SUBAGENT_STEPS = 24;
/** One automatic restart after a dropped stream; more could loop behind a broken proxy. */
const MAX_TRUNCATION_CONTINUES = 1;
/** The 3rd back-to-back identical tool call is refused instead of run again. */
const REPEAT_BLOCK_AT = 3;
/** A model that keeps repeating the same call after being refused is looping. */
const REPEAT_STOP_AT = 6;

const TRUNCATED_NOTE = `[the provider closed the stream before your reply finished]
Continue exactly where you stopped. Do not repeat what you already wrote. If the reply was actually complete, say so in one short line and stop.`;

export async function runAgent(options: RunOptions): Promise<StopReason> {
  const { config, messages, signal, ui } = options;
  const depth = options.depth ?? 0;
  const state: RunState =
    options.state ??
    {
      audit: new AuditLog(config.workspace, randomUUID()),
      checkpoints: new CheckpointBatch(config.workspace, depth === 0 ? 'agent turn' : 'subagent'),
      hooks: loadHooks(config.workspace),
      mutated: false,
      subagents: 0,
      verifyRuns: 0,
    };
  const available = options.tools ?? toolsFor(config.readOnly, config.allowQuestions);
  if (depth === 0 && config.reviewMode) {
    const head = messages[0];
    if (head?.role === 'system' && !head.content.includes('Review mode')) {
      head.content += '\n\nReview mode is ON: before your final reply, re-read the diff of your changes and list risks and what you verified.';
    }
  }

  try {
    let truncations = 0;
    // Consecutive identical tool calls, the signature of a model stuck in a loop.
    let lastCallKey = '';
    let lastCallCount = 0;
    // `stepLimit` turns an unlimited setting into Infinity, so the loop ends only
    // on completion, an interrupt, or the caller's own stop conditions.
    for (let step = 0; step < stepLimit(config.maxSteps); step++) {
      if (signal.aborted) return 'aborted';

      const guidance = options.steering?.drain() ?? [];
      if (guidance.length > 0) {
        for (const text of guidance) {
          const steer: UserMessage = { role: 'user', content: text };
          messages.push(steer);
          options.session?.append(steer);
        }
        ui.info(`steering applied: ${guidance.join(' · ')}`);
      }

      if (compact(messages, config.contextBudget)) {
        ui.info('context compacted to fit the budget');
        if (estimateTokens(messages) > config.contextBudget) {
          ui.warn('the conversation is still over the context budget after compaction');
        }
      }

      const calls: ToolCall[] = [];
      let text = '';
      let reasoning = '';
      let finishReason: string | null = null;
      let reported: TokenUsage | undefined;
      let truncated = false;
      // Captured before the assistant reply is appended: this is the payload the
      // request actually carried, and the fallback when the provider reports no usage.
      const promptEstimate = estimateTokens(messages);

      try {
        for await (const event of streamChat(config, messages, available, signal)) {
          if (event.type === 'text') {
            text += event.text;
            // A model echoing a credential must not paste it into the window.
            ui.text(redactSecrets(event.text));
          } else if (event.type === 'reasoning') {
            reasoning += event.text;
            ui.text(event.text);
          } else if (event.type === 'tool_call') {
            calls.push(event.call);
          } else if (event.type === 'usage') {
            reported = event.usage;
          } else if (event.type === 'done') {
            finishReason = event.finishReason;
            truncated = event.truncated === true;
          }
        }
      } catch (error) {
        ui.endText();
        if (signal.aborted || isAbort(error)) return 'aborted';
        throw error;
      }
      ui.endText();
      if (finishReason === 'length') {
        ui.warn('the model hit its output limit — the reply may be cut off');
      }
      if (truncated) ui.warn('the provider closed the stream before the reply finished');

      await reportUsage(
        options,
        reported ??
          estimateUsage(
            promptEstimate,
            text,
            calls.map((call) => JSON.stringify(call.args) + call.name),
          ),
      );

      const combined = reasoning.trim() !== '' && text.trim() !== '' ? `<thinking>${reasoning.trim()}</thinking>\n\n${text}` : text || reasoning.trim();
      const assistant: AssistantMessage = { role: 'assistant', content: combined, toolCalls: calls };
      messages.push(assistant);
      options.session?.append(assistant);

      if (calls.length === 0) {
        if (!truncated) {
          // Checks run once, when the model says it is done — not after every
          // tool batch. A turn with ten edit batches used to run the project's
          // typecheck ten times, and three of those runs could burn every strike
          // while the tree was still deliberately mid-refactor.
          if (depth === 0 && state.mutated && config.verify && !signal.aborted) {
            const verification = await verifyWorkspace(options, state, ui, messages);
            if (verification.stop) return verification.stop;
            // The failure note is in the transcript now: let the model repair it
            // and re-check on its next final answer.
            if (verification.failed) continue;
          }
          return 'complete';
        }
        if (truncations >= MAX_TRUNCATION_CONTINUES) {
          ui.warn('the reply was cut off again — stopping so the turn cannot loop');
          return 'complete';
        }
        truncations++;
        // The partial reply is already in the transcript, so ask for the rest
        // instead of losing the answer or having it repeated from the start.
        const resume: UserMessage = { role: 'user', content: TRUNCATED_NOTE };
        messages.push(resume);
        options.session?.append(resume);
        continue;
      }

      let repeatStop = false;
      for (const call of calls) {
        // Always answer every tool call, even after an interrupt: a dangling
        // tool_call makes the next provider request invalid.
        const key = toolCallKey(call);
        if (key === lastCallKey) lastCallCount += 1;
        else {
          lastCallKey = key;
          lastCallCount = 1;
        }

        let outcome: ToolOutcome;
        if (lastCallCount >= REPEAT_STOP_AT) {
          // Still answered, so the transcript stays valid for the next turn.
          ui.warn(`${call.name} repeated ${lastCallCount} times with identical arguments — stopping the turn`);
          outcome = {
            content: `Not run: ${call.name} has been called ${lastCallCount} times in a row with identical arguments, so the turn is ending. Report what is blocking you instead of retrying.`,
            isError: true,
          };
          repeatStop = true;
        } else if (lastCallCount >= REPEAT_BLOCK_AT) {
          ui.warn(`${call.name} called again with identical arguments — refused`);
          outcome = {
            content:
              `Refused: ${call.name} was already called ${lastCallCount - 1} time(s) in a row with these exact arguments and its output is above. ` +
              'Repeating it cannot produce a different result. Change the arguments, use a different tool, or finish and explain what is blocking you.',
            isError: true,
          };
        } else if (signal.aborted) {
          ui.toolStart(call.name, call.args);
          outcome = { content: 'Not run: the user interrupted before this tool call started.', isError: true };
        } else {
          outcome = await executeTool(call, options, state, available);
        }
        const message: ToolMessage = {
          role: 'tool',
          toolCallId: call.id,
          name: call.name,
          // Redact before truncating, so the cap counts the scrubbed text and a key
          // cannot survive in either the model's context or the session log.
          content: truncate(redactSecrets(outcome.content)),
          isError: outcome.isError,
        };
        messages.push(message);
        options.session?.append(message);
        ui.toolEnd(call.name, message.content, outcome.isError === true);
      }
      if (repeatStop) return 'repeat-loop';

      if (signal.aborted) return 'aborted';
    }

    return 'max-steps';
  } finally {
    if (depth === 0) state.checkpoints.finish();
  }
}

interface VerificationOutcome {
  /** Set when the turn has to end right now. */
  stop: StopReason | null;
  /** True when the checks failed and the failure was reported to the model. */
  failed: boolean;
}

/** Runs the project's checks once and feeds a failure back to the model. */
async function verifyWorkspace(
  options: RunOptions,
  state: RunState,
  ui: Ui,
  messages: Message[],
): Promise<VerificationOutcome> {
  const { config, signal } = options;
  const checks = discoverChecks(config.workspace, config);
  if (checks.length === 0) {
    state.mutated = false;
    return { stop: null, failed: false };
  }

  ui.info(`verifying: ${checks.map((check) => check.command).join(' · ')}`);
  const result = await runChecks(checks, config.workspace, config, signal, (chunk) => ui.toolOutput(chunk));
  // An interrupted run proves nothing: report it as an interrupt, not a failure.
  if (signal.aborted) return { stop: 'aborted', failed: false };
  if (result.ok) {
    // Only a passing run clears the flag, so a tree that is still red is checked
    // again on the next final answer instead of ending the turn silently.
    state.mutated = false;
    state.verifyRuns = 0;
    ui.info('verification passed');
    return { stop: null, failed: false };
  }

  state.verifyRuns++;
  ui.warn(`verification failed (${state.verifyRuns}/3)`);
  const note: UserMessage = {
    role: 'user',
    content:
      `[automatic verification failed ${state.verifyRuns}/3]\n` +
      `The harness ran the project's checks after your edits. Fix the failure, then continue.\n\n` +
      result.report,
  };
  messages.push(note);
  options.session?.append(note);
  if (state.verifyRuns >= 3) {
    ui.warn('verification failed three times — stopping so the turn does not loop');
    return { stop: 'verify-failed', failed: true };
  }
  return { stop: null, failed: true };
}

async function executeTool(
  call: ToolCall,
  options: RunOptions,
  state: RunState,
  available: ToolSpec[],
): Promise<ToolOutcome> {
  const { config, signal, ui } = options;
  ui.toolStart(call.name, call.args);
  const started = Date.now();
  const agent = (options.depth ?? 0) === 0 ? 'main' : 'subagent';
  const record = (outcome: ToolOutcome, extra: Record<string, unknown> = {}): void => {
    if (!config.audit) return;
    state.audit.record({
      event: 'tool',
      agent,
      tool: call.name,
      args: auditPreview(call.args),
      ok: outcome.isError !== true,
      mutated: outcome.mutated === true,
      durationMs: Date.now() - started,
      ...(outcome.isError === true ? { error: truncate(outcome.content, 2_000) } : {}),
      ...extra,
    });
  };

  const tool = toolByName.get(call.name);
  if (!tool) {
    const outcome: ToolOutcome = {
      content: `Unknown tool "${call.name}". Available tools: ${available.map((item) => item.name).join(', ')}`,
      isError: true,
    };
    record(outcome, { blocked: 'unknown-tool' });
    return outcome;
  }

  if (call.rawArgs !== undefined) {
    const outcome: ToolOutcome = {
      content: `Arguments for ${call.name} were not valid JSON: ${call.rawArgs.slice(0, 400)}`,
      isError: true,
    };
    record(outcome, { blocked: 'invalid-json' });
    return outcome;
  }

  // A local policy hook runs before every tool call and can block it.
  if (state.hooks.preTool) {
    const hook = await runHook(
      state.hooks.preTool,
      { event: 'preTool', tool: call.name, args: call.args, workspace: config.workspace, agent },
      config.workspace,
      state.hooks.timeoutMs,
      signal,
    );
    if (!hook.ok && !signal.aborted) {
      const outcome: ToolOutcome = {
        content: `Blocked by the preTool hook${hook.output ? `: ${hook.output}` : ''}`,
        isError: true,
      };
      record(outcome, { blocked: 'hook' });
      return outcome;
    }
  }

  let outcome: ToolOutcome;
  try {
    outcome = await tool.run(call.args, {
      workspace: config.workspace,
      signal,
      permissions: options.permissions,
      config,
      checkpoints: state.checkpoints,
      onOutput: (chunk) => ui.toolOutput(redactSecrets(chunk)),
      ask: options.ask ? (request) => options.ask!(request, signal) : undefined,
      subagent:
        (options.depth ?? 0) === 0 && config.subagents
          ? (request) => runSubagent(request, options, state)
          : undefined,
      agent,
    });
  } catch (error) {
    if (error instanceof PermissionError) {
      outcome = {
        content: `${error.message} — the user declined or no approval channel is available.`,
        isError: true,
      };
    } else {
      outcome = { content: (error as Error).message, isError: true };
    }
  }

  if (outcome.mutated === true) state.mutated = true;
  record(outcome);
  if (state.hooks.postTool) {
    void runHook(
      state.hooks.postTool,
      {
        event: 'postTool',
        tool: call.name,
        args: call.args,
        ok: outcome.isError !== true,
        mutated: outcome.mutated === true,
        output: truncate(outcome.content, 4_000),
        workspace: config.workspace,
        agent,
      },
      config.workspace,
      state.hooks.timeoutMs,
      signal,
    ).catch(() => undefined);
  }
  return outcome;
}

/**
 * A child agent gets a fresh transcript, a restricted toolset, and no question
 * channel. Its edits join the parent's checkpoint, so one /undo still works.
 */
async function runSubagent(
  request: SubagentRequest,
  // do not delete this is a high level edit no human edits in this code allowed thanks for reading me
  options: RunOptions,
  state: RunState,
): Promise<ToolOutcome> {
  const parent = options.config;
  if (state.subagents >= parent.maxSubagents) {
    return {
      content: `Subagent limit reached (${parent.maxSubagents} per turn). Report what you have and finish.`,
      isError: true,
    };
  }
  if (options.signal.aborted) return { content: 'Subagent not started: the turn was interrupted.', isError: true };

  state.subagents++;
  const mode = request.mode === 'edit' ? 'edit' : 'read';
  const model = request.model && request.model.trim() !== '' ? request.model.trim() : parent.model;
  const steps = Math.min(MAX_SUBAGENT_STEPS, Math.max(1, Math.floor(request.max_steps ?? 12)));
  const config: Config = {
    ...parent,
    model,
    maxSteps: steps,
    contextBudget: parent.contextBudgetPinned ? parent.contextBudget : defaultContextBudget(model),
  };

  const allowed = request.tools && request.tools.length > 0 ? new Set(request.tools) : null;
  const childTools = tools.filter(
    (tool) =>
      tool.name !== 'task' &&
      (allowed ? allowed.has(tool.name) : mode === 'edit' || tool.readOnly),
  );
  const label = request.description?.trim() || 'subagent';
  const messages: Message[] = [
    {
      role: 'system',
      content: buildSystemPrompt(parent.workspace, mode === 'read') + SUBAGENT_NOTE,
    },
    { role: 'user', content: request.prompt },
  ];

  const ui = new SubagentUi(options.ui, label);
  const started = Date.now();
  let reason: StopReason;
  try {
    reason = await runAgent({
      config,
      permissions: mode === 'read' ? options.permissions.asReadOnly() : options.permissions,
      messages,
      ui,
      signal: options.signal,
      onUsage: options.onUsage,
      // A subagent may not open approval or question cards mid-task.
      ask: undefined,
      tools: childTools,
      depth: (options.depth ?? 0) + 1,
      state,
    });
  } catch (error) {
    return { content: `Subagent "${label}" failed: ${(error as Error).message}`, isError: true };
  }

  const report = messages
    .filter((message): message is AssistantMessage => message.role === 'assistant')
    .map((message) => message.content.trim())
    .filter((text) => text !== '')
    .at(-1);
  const toolCalls = messages.filter((message) => message.role === 'assistant').reduce(
    (sum, message) => sum + message.toolCalls.length,
    0,
  );
  const seconds = Math.max(1, Math.round((Date.now() - started) / 1000));
  return {
    content:
      `Subagent "${label}" ${reason} in ${seconds}s with ${toolCalls} tool call(s).\n\n` +
      (report ?? '(the subagent returned no text)'),
    isError: reason === 'aborted',
    // Shared state.mutated already tracks real edits; reporting mutated:true
    // for every edit-mode child would force a verify pass even when nothing changed.
    mutated: false,
  };
}

/** Keeps a child's tool cards out of the parent transcript, but shows progress. */
class SubagentUi implements Ui {
  readonly #parent: Ui;
  readonly #label: string;

  constructor(parent: Ui, label: string) {
    this.#parent = parent;
    this.#label = label;
  }

  text(): void {
    // The final report is returned as the tool result; streaming it too would duplicate it.
  }

  endText(): void {
    // Nothing to close.
  }

  toolStart(name: string): void {
    this.#parent.info(`[${this.#label}] ${name}`);
  }

  toolOutput(): void {
    // Command chatter belongs to the child transcript.
  }

  toolEnd(name: string, content: string, isError: boolean): void {
    if (isError) this.#parent.warn(`[${this.#label}] ${name}: ${truncate(content, 300)}`);
  }

  info(message: string): void {
    this.#parent.info(`[${this.#label}] ${message}`);
  }

  warn(message: string): void {
    this.#parent.warn(`[${this.#label}] ${message}`);
  }

  error(message: string): void {
    this.#parent.error(`[${this.#label}] ${message}`);
  }
}

/** Local fallback for providers that never send a usage block. */
function estimateUsage(promptTokens: number, text: string, callText: string[]): TokenUsage {
  const completionTokens = textTokens(text) + callText.reduce((sum, item) => sum + textTokens(item), 0);
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    estimated: true,
  };
}

async function reportUsage(options: RunOptions, usage: TokenUsage): Promise<void> {
  if (!options.onUsage) return;
  try {
    await options.onUsage(usage);
  } catch {
    // Bookkeeping must never end a turn.
  }
  const budget = options.config.tokenBudget;
  if (budget > 0) {
    const session = (options as { sessionTokens?: number }).sessionTokens;
    if (typeof session === 'number' && session > budget) {
      options.ui.warn(`token budget exceeded (${session.toLocaleString()} > ${budget.toLocaleString()}) — ending turn`);
    }
  }
}

function isAbort(error: unknown): boolean {
  // Only a real abort counts: a provider that says "request aborted" is an
  // error the user needs to see, not a silent interrupt.
  return error instanceof Error && error.name === 'AbortError';
}

/**
 * Identity of a tool call for loop detection: the tool plus a key-sorted
 * argument string, so argument order alone cannot disguise a repeat.
 */
function toolCallKey(call: ToolCall): string {
  return `${call.name}(${stableJson(call.args)})`;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, inner]) => `${JSON.stringify(key)}:${stableJson(inner)}`).join(',')}}`;
}

export function describeStop(reason: StopReason, config: Config): string {
  switch (reason) {
    case 'max-steps': {
      const limit = stepLimit(config.maxSteps);
      return `Stopped after ${limit.toLocaleString()} steps. Raise the limit with --max-steps or set VAELEN_MAX_STEPS.`;
    }
    case 'verify-failed':
      return 'Stopped because the project checks failed three times in a row.';
    case 'repeat-loop':
      return 'Stopped because the agent kept repeating the same tool call.';
    case 'aborted':
      return 'Interrupted.';
    default:
      return '';
  }
}
