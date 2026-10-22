#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import process from 'node:process';
import { createInterface, type Interface } from 'node:readline';
import { describeStop, runAgent } from './agent.ts';
import { AuditLog } from './audit.ts';
import { listCheckpoints, restoreLatest } from './checkpoints.ts';
import { compactReport, filterAudit, formatAuditLine, writeExport } from './pro.ts';
import {
  configFilePath,
  contextWindowFor,
  defaultContextBudget,
  loadConfig,
  requiresApiKey,
  saveFileConfig,
  type Config,
} from './config.ts';
import { compact, estimateTokens, repairToolCalls } from './context.ts';
import { connectMcpServers } from './mcp.ts';
import {
  Permissions,
  parseApprovalAnswer,
  type ApprovalDecision,
  type ApprovalRequest,
} from './permissions.ts';
import { buildSystemPrompt } from './prompt.ts';
import { discoverChecks, runChecks } from './verify.ts';
import { ProviderError } from './provider.ts';
import { JsonUi, style, TerminalUi } from './render.ts';
import { redactSecrets } from './secrets.ts';
import { buildRepoMap } from './repomap.ts';
import { Session } from './session.ts';
import { toolsFor } from './tools/index.ts';
import type { Message, QuestionRequest, TokenUsage, UserMessage } from './types.ts';
import { countOf, describeUsage, loadUsage, recordUsage, usageFilePath } from './usage.ts';
import { describeTime, formatDuration, loadTime, recordTime } from './time.ts';

const VERSION = '0.1.0';

interface CliArgs {
  workspace?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  yolo: boolean;
  ask: boolean;
  resume?: string;
  maxSteps?: number;
  contextBudget?: number;
  print?: string;
  saveKey: boolean;
  json: boolean;
  noVerify: boolean;
  noSubagents: boolean;
  noMcp: boolean;
  noAudit: boolean;
  pro: boolean;
  fallbackModel?: string;
  tokenBudget?: number;
  opencodeKey?: string;
  free: boolean;
  help: boolean;
  version: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    yolo: false,
    ask: false,
    saveKey: false,
    json: false,
    noVerify: false,
    noSubagents: false,
    noMcp: false,
    noAudit: false,
    pro: false,
    free: false,
    help: false,
    version: false,
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] ?? '';
    const value = (): string => {
      const next = argv[++index];
      if (next === undefined) fail(`Missing value for ${arg}`);
      return next;
    };
    const positiveNumber = (): number => {
      const raw = value();
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        fail(`${arg} needs a positive number, got "${raw}"`);
      }
      return parsed;
    };
    // `--max-steps 0` is how a script asks for no cap; other flags stay positive.
    const stepCount = (): number => {
      const raw = value();
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed < 0) {
        fail(`${arg} needs a step count (0 for unlimited), got "${raw}"`);
      }
      return parsed;
    };

    switch (arg) {
      case '-h':
      case '--help':
        args.help = true;
        break;
      case '-v':
      case '--version':
        args.version = true;
        break;
      case '-C':
      case '--workspace':
        args.workspace = value();
        break;
      case '-m':
      case '--model':
        args.model = value();
        break;
      case '--base-url':
        args.baseUrl = value();
        break;
      case '--api-key':
        args.apiKey = value();
        break;
      case '-y':
      case '--yolo':
        args.yolo = true;
        break;
      case '--ask':
        args.ask = true;
        break;
      case '--resume':
        args.resume = value();
        break;
      case '--max-steps':
        args.maxSteps = stepCount();
        break;
      case '--context-budget':
        args.contextBudget = positiveNumber();
        break;
      case '--save-key':
        args.saveKey = true;
        break;
      case '--json':
        args.json = true;
        break;
      case '--no-verify':
        args.noVerify = true;
        break;
      case '--no-subagents':
        args.noSubagents = true;
        break;
      case '--no-mcp':
        args.noMcp = true;
        break;
      case '--no-audit':
        args.noAudit = true;
        break;
      case '--pro':
        args.pro = true;
        break;
      case '--fallback-model':
        args.fallbackModel = value();
        break;
      case '--token-budget':
        args.tokenBudget = positiveNumber();
        break;
      case '--free':
        args.free = true;
        break;
      case '--opencode-key':
        args.opencodeKey = value();
        break;
      case '-p':
      case '--print':
        args.print = value();
        break;
      default:
        if (arg.startsWith('-')) fail(`Unknown option: ${arg}`);
        if (args.print !== undefined) fail('Only one prompt can be passed positionally.');
        args.print = arg;
    }
  }

  return args;
}

function fail(message: string): never {
  process.stderr.write(`${style.red('✗')} ${message}\n`);
  process.exit(1);
}

function printHelp(): void {
  process.stdout.write(`Vaelen ${VERSION} — a small coding agent harness.

Usage:
  vaelen                       interactive session in the current directory
  vaelen "fix the failing test"   one-shot prompt
  vaelen --resume <session.jsonl>

Options:
  -C, --workspace <dir>   Project root (default: current directory)
  -m, --model <name>      Model id (default: $VAELEN_MODEL or deepseek-flash)
      --base-url <url>    OpenAI-compatible endpoint (default: https://api.deepseek.com)
      --api-key <key>     API key (default: $VAELEN_API_KEY, $DEEPSEEK_API_KEY, $OPENAI_API_KEY)
      --free              Use OpenCode's free DeepSeek (needs $OPENCODE_API_KEY, no DeepSeek key)
      --opencode-key <key>  OpenCode key for free models (default: $OPENCODE_API_KEY)
      --max-steps <n>     Max tool round-trips per turn (default: 100, 0 = no limit)
      --context-budget <n>  Tokens before compaction (default: 80% of the model window)
      --resume <file>     Continue a saved session
      --save-key          Persist the API key to ~/.vaelen/config.json
      --ask               Ask before writes and commands that are not provably read-only
      --json              Emit one JSON object per event (for scripts)
      --no-verify         Do not run project checks after edits
      --no-subagents      Disable the task tool
      --no-mcp            Do not connect MCP servers
      --no-audit          Do not write .vaelen/audit.jsonl
      --pro               Pro mode: longer verify window, more subagents, review commands
  -y, --yolo              Skip approval prompts (already the default)
  -h, --help              Show this help
  -v, --version           Print version

Commands run without prompting by default. Disk, boot, registry, service,
account, and OS-directory operations are always refused (even with --yolo).

REPL commands:
  /help  /clear  /model <name>  /context  /usage  /session  /tools
  /undo  /audit [n] [query]  /map [query]  /checkpoints  /verify
  /compact  /export [md|json]  /validate <file>  /toon <file>  /chats
  /cd <dir>  /resume [n]  /budget [n]  /review  /exit

Sessions are appended to .vaelen/sessions/*.jsonl in the workspace.
Every edit is snapshotted under .vaelen/checkpoints/ and can be undone.
Lifetime token use is kept in ~/.vaelen/usage.jsonl (override: VAELEN_USAGE_FILE).
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  if (args.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  const config = loadConfig({
    workspace: args.workspace,
    model: args.free && !args.model ? 'deepseek-v4.1-flash-free' : args.model,
    baseUrl: args.free ? 'https://opencode.ai/inference/openai/v1' : args.baseUrl,
    apiKey: args.apiKey,
    // `undefined` lets VAELEN_YOLO apply; passing `false` would mask it.
    yolo: args.yolo || undefined,
    autoApprove: args.ask ? false : undefined,
    maxSteps: args.maxSteps,
    contextBudget: args.contextBudget,
    verify: args.noVerify ? false : undefined,
    subagents: args.noSubagents ? false : undefined,
    mcp: args.noMcp ? false : undefined,
    audit: args.noAudit ? false : undefined,
    pro: args.pro ? true : undefined,
    fallbackModel: args.fallbackModel,
    tokenBudget: args.tokenBudget,
    opencodeKey: args.opencodeKey,
  });
  const ui = args.json ? new JsonUi() : new TerminalUi();

  if (args.saveKey) {
    if (config.apiKey === '') {
      fail('--save-key needs a key: pass --api-key or set DEEPSEEK_API_KEY.');
    }
    try {
      saveFileConfig({ apiKey: config.apiKey });
      ui.info(`saved API key to ${configFilePath()} — future sessions reconnect automatically`);
    } catch (error) {
      fail(`Could not save ${configFilePath()}: ${(error as Error).message}`);
    }
  }

  const interactive = args.print === undefined;
  const needsKey = requiresApiKey(config.baseUrl) && config.apiKey === '';

  if (needsKey) {
    if (interactive && process.stdin.isTTY) {
      process.stdout.write('\nWelcome to Vaelen — no API key found.\n');
      process.stdout.write('  Free path: sign in at https://opencode.ai, copy an API key, then\n');
      process.stdout.write('    vaelen --free --opencode-key <key>   (free DeepSeek V4.1 Flash, quota-limited)\n');
      process.stdout.write('  Or DeepSeek directly:\n');
      process.stdout.write('  1. Sign up: https://platform.deepseek.com/sign_up\n');
      process.stdout.write('  2. Create a key: https://platform.deepseek.com/api_keys → Create new API key\n');
      process.stdout.write('  3. Paste the sk-… value below (saved to ~/.vaelen/config.json).\n');
      process.stdout.write('  No key? Use Ollama: --base-url http://127.0.0.1:11434/v1 --api-key ollama\n\n');
      const ask = createInterface({ input: process.stdin, output: process.stdout });
      const answer = (
        await new Promise<string>((resolve) =>
          ask.question('DeepSeek API key (visible while typing): ', resolve),
        )
      ).trim();
      ask.close();
      if (answer === '') {
        ui.error('No key provided.');
        process.exitCode = 1;
        return;
      }
      config.apiKey = answer;
      try {
        saveFileConfig({ apiKey: answer });
        ui.info(`key saved to ${configFilePath()} — future sessions reconnect automatically`);
      } catch (error) {
        ui.warn(`could not save the key: ${(error as Error).message}`);
      }
    } else {
      ui.error(`No API key found for ${config.baseUrl}.`);
      ui.info('Set DEEPSEEK_API_KEY, pass --api-key, or write ~/.vaelen/config.json.');
      ui.info('Local servers work without a key: --base-url http://127.0.0.1:11434/v1 --api-key ollama');
      process.exitCode = 1;
      return;
    }
  }
  const rl = interactive
    ? createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) })
    : undefined;
  const lines = rl ? new LineQueue(rl) : undefined;

  let active: AbortController | undefined;

  const permissions = new Permissions({
    workspace: config.workspace,
    yolo: config.yolo,
    autoApprove: config.autoApprove,
    handler: async (request: ApprovalRequest): Promise<ApprovalDecision> => {
      if (!rl) return 'deny';
      if (!lines) return 'deny';
      return askApproval(lines, request, () => active?.signal);
    },
  });

  // One-shot mode has no console to answer on; leaving `ask` undefined lets
  // ask_user tell the model that instead of hanging the turn.
  const ask = lines
    ? (request: QuestionRequest, signal: AbortSignal): Promise<string | null> =>
        askQuestion(lines, request, signal)
    : undefined;

  // MCP servers must connect before the system prompt is built, because their
  // tools are part of the prompt's tool list.
  const mcp = config.mcp
    ? await connectMcpServers(config.workspace, { onWarn: (message) => ui.warn(message) })
    : undefined;
  if (mcp && mcp.tools.length > 0) {
    ui.info(
      `MCP: ${mcp.tools.length} tool(s) from ${mcp.clients.length} server(s)`,
    );
    process.once('exit', () => mcp.close());
  }

  const messages: Message[] = [{ role: 'system', content: buildSystemPrompt(config.workspace, false, config.reviewMode, config.allowQuestions) }];
  if (args.resume && !existsSync(args.resume)) fail(`No session file at ${args.resume}`);

  // A read-only workspace must not stop the agent from working; the transcript
  // simply is not written to disk.
  let session: Session | undefined;
  try {
    session = args.resume
      ? Session.open(args.resume)
      : Session.create(config.sessionDir, { model: config.model, workspace: config.workspace });
  } catch (error) {
    ui.warn(`session logging disabled: ${(error as Error).message}`);
  }

  // Lifetime totals are shared by every session on the machine; the counters
  // below are this process's share.
  const sessionId = randomUUID();
  const stats: UsageStats = { lifetime: loadUsage(), sessionTokens: 0, sessionRequests: 0 };
  const onUsage = async (usage: TokenUsage): Promise<void> => {
    stats.sessionTokens += usage.totalTokens;
    stats.sessionRequests += 1;
    if (config.tokenBudget > 0 && stats.sessionTokens > config.tokenBudget) {
      ui.warn(`token budget exceeded (${stats.sessionTokens.toLocaleString()} > ${config.tokenBudget.toLocaleString()})`);
    }
    stats.lifetime = await recordUsage({
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
      estimated: usage.estimated,
      model: config.model,
      workspace: config.workspace,
      session: sessionId,
    });
  };

  if (args.resume) {
    const loaded = Session.load(args.resume).filter((message) => message.role !== 'system');
    const repaired = repairToolCalls(loaded);
    messages.push(...loaded);
    ui.info(`resumed ${loaded.length} message(s) from ${args.resume}`);
    if (repaired > 0) ui.warn(`filled in ${repaired} tool result(s) missing from the saved session`);
  }

  if (!interactive) {
    ui.info(`${config.model} · ${config.workspace}`);
    const prompt: UserMessage = { role: 'user', content: redactSecrets(args.print ?? '') };
    messages.push(prompt);
    session?.append(prompt);

    const controller = new AbortController();
    active = controller;
    process.once('SIGINT', () => controller.abort());

    let failed = false;
    const turnStartedAt = Date.now();
    try {
      const reason = await runAgent({
        config,
        permissions,
        messages,
        ui,
        session,
        signal: controller.signal,
        onUsage,
        ask,
      });
      if (reason !== 'complete') ui.warn(describeStop(reason, config));
      if (reason === 'aborted') process.exitCode = 130;
    } catch (error) {
      failed = true;
      ui.error(formatError(error));
      process.exitCode = 1;
    } finally {
      // An unanswered prompt is not part of the conversation: keep it out of the
      // saved session so a resume does not replay a request the model never saw.
      if (failed && messages[messages.length - 1] === prompt && (args.print ?? '') !== '') {
        messages.pop();
        session?.retractLast();
      }
      try {
        await recordTime(Date.now() - turnStartedAt, sessionId);
      } catch {
        // Time ledger is best-effort.
      }
      await session?.close();
    }
    return;
  }

  ui.info(`Vaelen ${VERSION} · ${config.model} · ${config.workspace}`);
  ui.info(`endpoint: ${config.baseUrl}`);
  ui.info('Type a request, or /help for commands.');

  process.on('SIGINT', () => {
    if (active) {
      active.abort();
      ui.warn('interrupted');
    } else {
      rl?.close();
    }
  });

  while (true) {
    let input: string | null;
    try {
      input = await readPrompt(lines!);
    } catch {
      break;
    }
    if (input === null) break;

    const request = input.trim();
    if (request === '') continue;

    if (request.startsWith('/')) {
      const [command, ...rest] = request.split(/\s+/);
      if (command === '/exit' || command === '/quit') break;
      await handleCommand(command ?? '', rest.join(' '), config, messages, ui, session, stats);
      continue;
    }

    const userMessage: UserMessage = { role: 'user', content: redactSecrets(request) };
    messages.push(userMessage);
    session?.append(userMessage);

    const controller = new AbortController();
    active = controller;
    let failed = false;
    const turnStartedAt = Date.now();
    try {
      const reason = await runAgent({
        config,
        permissions,
        messages,
        ui,
        session,
        signal: controller.signal,
        onUsage,
        ask,
      });
      if (reason !== 'complete') ui.warn(describeStop(reason, config));
    } catch (error) {
      failed = true;
      ui.error(formatError(error));
    } finally {
      active = undefined;
      try {
        const turnMs = Date.now() - turnStartedAt;
        await recordTime(turnMs, sessionId);
        if (turnMs >= 1000) ui.info(`working time: ${formatDuration(turnMs)} this turn`);
      } catch {
        // Time ledger is best-effort.
      }
    }

    // The model never answered, so the prompt is not part of the conversation: a
    // later turn would otherwise send it along with the next thing typed.
    if (failed && messages[messages.length - 1] === userMessage) {
      messages.pop();
      session?.retractLast();
      ui.warn('that message was not sent to the model — press Up to resend it');
    }
  }

  rl?.close();
  await session?.close();
  if (session) ui.info(`session saved to ${session.path}`);
}

/**
 * Reads the REPL one line at a time from a queue fed by the `line` event.
 * Asking `rl.question` per prompt drops anything already buffered: piping
 * several commands into the CLI used to run only the first one.
 */
class LineQueue {
  readonly #rl: Interface;
  #lines: string[] = [];
  #waiters: ((line: string | null) => void)[] = [];
  #closed = false;

  constructor(rl: Interface) {
    this.#rl = rl;
    rl.on('line', (line: string) => {
      const waiter = this.#waiters.shift();
      if (waiter) waiter(line);
      else this.#lines.push(line);
    });
    rl.on('close', () => {
      this.#closed = true;
      for (const waiter of this.#waiters.splice(0)) waiter(null);
    });
  }

  /** Resolves null once the input closes, so the REPL can exit cleanly. */
  ask(prompt: string): Promise<string | null> {
    process.stdout.write(prompt);
    const queued = this.#lines.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.#closed) return Promise.resolve(null);
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  /** Releases a pending approval prompt after an abort. */
  interrupt(): void {
    this.#rl.write('\n');
  }
}

async function readPrompt(lines: LineQueue): Promise<string | null> {
  let buffer = '';
  while (true) {
    const prompt = buffer === '' ? `${style.cyan('›')} ` : `${style.dim('…')} `;
    const line = await lines.ask(prompt);
    if (line === null) return null;
    if (line.endsWith('\\')) {
      buffer += `${line.slice(0, -1)}\n`;
      continue;
    }
    return buffer + line;
  }
}

async function askApproval(
  lines: LineQueue,
  request: ApprovalRequest,
  currentSignal: () => AbortSignal | undefined,
): Promise<ApprovalDecision> {
  process.stdout.write('\n');
  const label =
    request.kind === 'bash'
      ? `Run command: ${request.target}`
      : request.kind === 'tool'
        ? `Use tool: ${request.target}`
        : `Modify file: ${request.target}`;
  process.stdout.write(`${style.yellow('approval needed')} ${label}\n`);

  const signal = currentSignal();
  if (signal?.aborted) return 'deny';

  const answer = await new Promise<string>((resolve) => {
    let settled = false;
    const finish = (value: string): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const onAbort = (): void => {
      finish('');
      // Release the pending prompt so the question does not stay stuck.
      lines.interrupt();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    void lines.ask(style.dim('  [y] once  [a] always  [n] no (default) › ')).then(
      (answer) => finish(answer ?? ''),
      () => finish(''),
    );
  });

  // Ctrl+C aborts the turn; the approval must not be granted by the empty answer.
  if (signal?.aborted) return 'deny';
  // Enter and EOF arrive as '', which parseApprovalAnswer denies.
  return parseApprovalAnswer(answer);
}

async function askQuestion(
  lines: LineQueue,
  request: QuestionRequest,
  signal: AbortSignal,
): Promise<string | null> {
  process.stdout.write(`\n${style.yellow('?')} ${request.question}\n`);
  request.options.forEach((option, index) => {
    process.stdout.write(`  ${index + 1}. ${option}\n`);
  });
  if (signal.aborted) return null;

  const answer = await new Promise<string | null>((resolve) => {
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const onAbort = (): void => {
      finish(null);
      // Release the pending prompt so the question does not stay stuck.
      lines.interrupt();
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void lines
      .ask(style.dim(request.options.length > 0 ? '  answer or number › ' : '  answer › '))
      .then((value) => finish(value), () => finish(null));
  });

  if (answer === null) return null;
  const trimmed = answer.trim();
  // With options, Enter means "skip"; without them, an empty answer is a valid
  // (if unhelpful) answer the model can see.
  if (trimmed === '') return request.options.length > 0 ? null : '';
  if (request.options.length > 0) {
    const index = Number(trimmed);
    if (Number.isInteger(index) && index >= 1 && index <= request.options.length) {
      return request.options[index - 1] ?? trimmed;
    }
  }
  return trimmed;
}

interface UsageStats {
  lifetime: ReturnType<typeof loadUsage>;
  sessionTokens: number;
  sessionRequests: number;
}

async function handleCommand(
  command: string,
  argument: string,
  config: Config,
  messages: Message[],
  ui: TerminalUi | JsonUi,
  session: Session | undefined,
  stats: UsageStats,
): Promise<void> {
  switch (command) {
    case '/help':
      ui.info('/clear — reset the conversation   /model <name> — switch model');
      ui.info('/context — token estimate   /usage — lifetime tokens   /session — log path');
      ui.info('/tools — list tools   /undo — restore the last turn   /audit [n] [query] — recent tool calls');
      ui.info('/map [query] — symbol map   /checkpoints — list undo history   /verify — run project checks');
      ui.info('/ask [auto|ask] — toggle whether the model may ask you clarifying questions');
      ui.info('/compact — compact now   /export [md|json] — save transcript   /exit — quit');
      if (config.pro) ui.info('pro mode: on (longer verify window, 8 subagents, review commands)');
      break;
    case '/clear':
      messages.splice(1);
      session?.markCleared();
      ui.info('conversation cleared (the system prompt stays)');
      break;
    case '/model':
      if (argument === '') {
        ui.info(`model: ${config.model}`);
      } else {
        config.model = argument;
        // An unpinned budget follows the new model's window.
        if (!config.contextBudgetPinned) config.contextBudget = defaultContextBudget(config.model);
        ui.info(`model: ${config.model} · context budget ${config.contextBudget.toLocaleString()}`);
      }
      break;
    case '/context':
      ui.info(
        `${estimateTokens(messages).toLocaleString()} tokens · budget ${config.contextBudget.toLocaleString()}` +
          ` of a ${contextWindowFor(config.model).toLocaleString()} token window`,
      );
      break;
    case '/usage':
      ui.info(
        `this session: ${stats.sessionTokens.toLocaleString()} tokens over ${countOf(stats.sessionRequests, 'request')}`,
      );
      ui.info(`lifetime: ${describeUsage(stats.lifetime)}`);
      ui.info(`ledger: ${usageFilePath()}`);
      try {
        ui.info(`working time: ${describeTime(loadTime())} lifetime`);
      } catch {
        // Time ledger is best-effort; tokens already reported above.
      }
      break;
    case '/session':
      ui.info(session ? session.path : 'session logging is off for this run');
      break;
    case '/tools': {
      const all = toolsFor(false);
      const readOnly = all.filter((tool) => tool.readOnly);
      const mutating = all.filter((tool) => !tool.readOnly);
      ui.info(`tools (${all.length}): ${mutating.map((tool) => tool.name).join(', ')}`);
      ui.info(`read-only (${readOnly.length}): ${readOnly.map((tool) => tool.name).join(', ')}`);
      if (config.pro) ui.info('pro: verify, checkpoints, compact, and export are enabled in /help');
      break;
    }
    case '/undo': {
      const restored = restoreLatest(config.workspace);
      if (!restored) {
        ui.warn('nothing to undo');
        break;
      }
      ui.info(
        `restored ${restored.files.length} file(s) from ${restored.id}` +
          (restored.files.length > 0 ? `: ${restored.files.join(', ')}` : ''),
      );
      const remaining = listCheckpoints(config.workspace).length;
      if (remaining > 0) ui.info(`${remaining} older checkpoint(s) remain — /undo again walks further back`);
      break;
    }
    case '/audit': {
      const parts = argument.split(/\s+/).filter((part) => part !== '');
      const maybeCount = Number(parts[0]);
      const hasCount = parts.length > 0 && Number.isFinite(maybeCount) && maybeCount > 0;
      const count = hasCount ? Math.min(100, Math.floor(maybeCount)) : 20;
      const query = hasCount ? parts.slice(1).join(' ') : parts.join(' ');
      const audit = new AuditLog(config.workspace, '');
      const entries = filterAudit(audit.tail(100), query).slice(-count);
      ui.info(`audit: ${audit.path}`);
      if (entries.length === 0) ui.info('no tool calls recorded yet');
      for (const entry of entries) ui.info(formatAuditLine(entry));
      break;
    }
    case '/map': {
      const map = await buildRepoMap(config.workspace, { query: argument || undefined });
      ui.info(map.text);
      break;
    }
    case '/checkpoints': {
      const checkpoints = listCheckpoints(config.workspace);
      if (checkpoints.length === 0) {
        ui.info('no checkpoints yet — edits create them automatically');
        break;
      }
      ui.info(`${checkpoints.length} checkpoint(s), newest first:`);
      for (const checkpoint of checkpoints.slice(0, 20)) {
        ui.info(`${checkpoint.id} · ${checkpoint.files} file(s) · ${checkpoint.label}${checkpoint.partial ? ' · partial' : ''}`);
      }
      break;
    }
    case '/verify': {
      const checks = discoverChecks(config.workspace, config);
      if (checks.length === 0) {
        ui.info('no verification checks found (add typecheck/lint/test scripts to package.json)');
        break;
      }
      ui.info(`verifying: ${checks.map((check) => check.command).join(' · ')}`);
      const controller = new AbortController();
      const result = await runChecks(checks, config.workspace, config, controller.signal);
      ui.info(result.report === '' ? '(no output)' : result.report.slice(0, 6000));
      ui.info(result.ok ? 'verification passed' : 'verification failed');
      break;
    }
    case '/compact': {
      const before = estimateTokens(messages);
      const changed = compact(messages, config.contextBudget);
      const after = estimateTokens(messages);
      const report = compactReport(before, after, changed);
      ui.info(
        changed
          ? `compacted: ${report.before.toLocaleString()} → ${report.after.toLocaleString()} tokens (saved ${report.saved.toLocaleString()})`
          : `already under budget: ${after.toLocaleString()} / ${config.contextBudget.toLocaleString()} tokens`,
      );
      break;
    }
    case '/export': {
      if (argument.trim() === 'audit') {
        const { writeAuditExport } = await import('./pro.ts');
        const audit = new AuditLog(config.workspace, '');
        const path = writeAuditExport(config.workspace, audit.tail(500));
        ui.info(`exported audit to ${path}`);
        break;
      }
      const format = argument.trim() === 'json' ? 'json' : 'md';
      const path = writeExport(config.workspace, messages, format);
      ui.info(`exported ${messages.length} message(s) to ${path}`);
      break;
    }
    case '/validate': {
      if (argument.trim() === '') { ui.warn('usage: /validate <file.json>'); break; }
      try {
        const { readFileSync } = await import('node:fs');
        const { resolve } = await import('node:path');
        const raw = readFileSync(resolve(config.workspace, argument.trim()), 'utf8');
        JSON.parse(raw);
        ui.info(`${argument.trim()}: valid JSON (${raw.length} chars)`);
      } catch (error) { ui.warn(`invalid: ${(error as Error).message}`); }
      break;
    }
    case '/toon': {
      if (argument.trim() === '') { ui.warn('usage: /toon <file.json>'); break; }
      try {
        const { readFileSync } = await import('node:fs');
        const { resolve } = await import('node:path');
        const { encodeToon } = await import('./toon.ts');
        const raw = readFileSync(resolve(config.workspace, argument.trim()), 'utf8');
        const doc = JSON.parse(raw) as unknown;
        const out = encodeToon(doc as never);
        ui.info(out.slice(0, 6000));
      } catch (error) { ui.warn(`toon failed: ${(error as Error).message}`); }
      break;
    }
    case '/chats':
    case '/resume': {
      try {
        const { readdirSync, statSync } = await import('node:fs');
        const { join } = await import('node:path');
        const dir = join(config.workspace, '.vaelen', 'sessions');
        const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort().slice(-20);
        if (files.length === 0) { ui.info('no saved sessions'); break; }
        files.forEach((f, i) => {
          let size = 0;
          try { size = statSync(join(dir, f)).size; } catch { size = 0; }
          ui.info(`${i + 1}. ${f} (${(size / 1024).toFixed(1)}KB)`);
        });
        ui.info('resume with: vaelen --resume <file>');
      } catch { ui.info('no saved sessions'); }
      break;
    }
    case '/cd': {
      const target = argument.trim();
      if (target === '') { ui.info(`workspace: ${config.workspace}`); break; }
      try {
        const { resolve } = await import('node:path');
        const { existsSync, statSync } = await import('node:fs');
        const next = resolve(config.workspace, target);
        if (!existsSync(next) || !statSync(next).isDirectory()) { ui.warn(`not a directory: ${target}`); break; }
        config.workspace = next;
        config.sessionDir = `${next}/.vaelen/sessions`;
        ui.info(`workspace: ${next}`);
      } catch (error) { ui.warn(`cd failed: ${(error as Error).message}`); }
      break;
    }
    case '/budget': {
      const n = Number(argument.trim());
      if (argument.trim() === '') { ui.info(`token budget: ${config.tokenBudget > 0 ? config.tokenBudget.toLocaleString() : 'unlimited'} (session ${stats.sessionTokens.toLocaleString()})`); break; }
      if (!Number.isFinite(n) || n < 0) { ui.warn('usage: /budget [tokens, 0 = unlimited]'); break; }
      config.tokenBudget = Math.floor(n);
      ui.info(`token budget: ${config.tokenBudget > 0 ? config.tokenBudget.toLocaleString() : 'unlimited'}`);
      break;
    }
    case '/review': {
      config.reviewMode = !config.reviewMode;
      ui.info(`review mode: ${config.reviewMode ? 'on — the model will self-review before finishing' : 'off'}`);
      break;
    }
    case '/ask': {
      const arg = argument.trim().toLowerCase();
      let ask: boolean;
      if (arg === '') {
        ask = !config.allowQuestions;
      } else if (['ask', 'on', 'all', 'yes', '1'].includes(arg)) {
        ask = true;
      } else if (['auto', 'off', 'no', 'none', '0'].includes(arg)) {
        ask = false;
      } else {
        ui.warn('usage: /ask [auto|ask] — auto asks no questions, ask allows clarifying questions');
        break;
      }
      config.allowQuestions = ask;
      const head = messages[0];
      if (head?.role === 'system') {
        head.content = buildSystemPrompt(config.workspace, config.readOnly, config.reviewMode, config.allowQuestions);
      }
      ui.info(ask ? 'ask mode: the model may ask high-level clarifying questions' : 'ask mode: no questions — the model proceeds with its best guess');
      break;
    }
    default:
      ui.warn(`Unknown command: ${command}`);
  }
}

function formatError(error: unknown): string {
  if (error instanceof ProviderError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

main().catch((error: unknown) => {
  process.stderr.write(`${style.red('✗')} ${formatError(error)}\n`);
  process.exit(1);
});
