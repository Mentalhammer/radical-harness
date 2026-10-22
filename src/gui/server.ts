import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  appendFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { runAgent } from '../agent.ts';
import { AuditLog } from '../audit.ts';
import { listCheckpoints, restoreLatest } from '../checkpoints.ts';
import {
  configFilePath,
  contextWindowFor,
  defaultContextBudget,
  loadConfig,
  MAX_STEPS_CEILING,
  normalizeMaxSteps,
  requiresApiKey,
  saveFileConfig,
  type Config,
} from '../config.ts';
import { estimateTokens, repairToolCalls } from '../context.ts';
import { connectMcpServers, type McpManager } from '../mcp.ts';
import { Permissions, type ApprovalDecision, type ApprovalRequest } from '../permissions.ts';
import { buildSystemPrompt } from '../prompt.ts';
import { ProviderError } from '../provider.ts';
import { redactSecrets } from '../secrets.ts';
import { searchChats } from '../search.ts';
import { knownWorkspaces, recordWorkspace, sessionDirFor } from '../workspaces.ts';
import {
  forgetRepo,
  ghStatus,
  listOwnRepos,
  loadHistory,
  openRepo,
  parseRepo,
  recordRepo,
  repoLabel,
  repoPath,
  type RepoRef,
} from '../repos.ts';
import type { Ui } from '../render.ts';
import { Session } from '../session.ts';
import type { Attachment, Message, QuestionRequest, TokenUsage, UserMessage } from '../types.ts';
import { loadUsage, recordUsage, usageFilePath, type TokenTotals } from '../usage.ts';
import { loadTime, recordTime, timeFilePath, type TimeTotals } from '../time.ts';
import html from './ui.html';

const VERSION = '0.1.0';
const MAX_BODY_BYTES = 20_000_000;
const MAX_ATTACHMENTS = 6;
const MAX_IMAGE_BYTES = 8_000_000;
const MAX_TEXT_CHARS = 1_000_000;
const MAX_TOTAL_BYTES = 12_000_000;
const MAX_CONTEXT_BUDGET = 10_000_000;
// A stable origin keeps the browser's localStorage (and the saved API key) across launches.
const DEFAULT_PORT = 47821;

// The packaged exe is a windowed app: double-clicking it has no console, so a
// stdout write throws EBADF. Everything printed also lands in this log, which
// is the only record of a launch that never showed a terminal.
const LOG_PATH = join(homedir(), '.vaelen', 'gui.log');

function log(text: string): void {
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    appendFileSync(LOG_PATH, text);
  } catch {
    // A read-only home must not stop the window from opening.
  }
}

/** Output for humans: console when one exists, log file always (optionally redacted). */
function say(text: string, logText = text): void {
  try {
    process.stdout.write(text);
  } catch {
    // No console attached; the log has it.
  }
  log(logText);
}

function fail(text: string): void {
  try {
    process.stderr.write(text);
  } catch {
    // No console attached; the log has it.
  }
  log(text);
}

interface GuiArgs {
  workspace?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  port?: number;
  contextBudget?: number;
  noOpen: boolean;
  browser: boolean;
  yolo: boolean;
  ask: boolean;
  noVerify: boolean;
  noSubagents: boolean;
  noMcp: boolean;
  noAudit: boolean;
  pro: boolean;
  fallbackModel?: string;
  tokenBudget?: number;
  opencodeKey?: string;
  free: boolean;
  review: boolean;
  help: boolean;
  version: boolean;
}

function parseArgs(argv: string[]): GuiArgs {
  const args: GuiArgs = {
    noOpen: false,
    browser: false,
    yolo: false,
    ask: false,
    noVerify: false,
    noSubagents: false,
    noMcp: false,
    noAudit: false,
    pro: false,
    free: false,
    review: false,
    help: false,
    version: false,
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] ?? '';
    const value = (): string => {
      const next = argv[++index];
      if (next === undefined) {
        fail(`Missing value for ${arg}\n`);
        process.exit(2);
      }
      return next;
    };
    const number = (min: number, max: number): number => {
      const raw = value();
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
        fail(`${arg} must be a number between ${min} and ${max}, got "${raw}"\n`);
        process.exit(2);
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
      case '--port':
        args.port = number(0, 65_535);
        break;
      case '--context-budget':
        args.contextBudget = number(1_001, MAX_CONTEXT_BUDGET);
        break;
      case '--no-open':
        args.noOpen = true;
        break;
      case '--browser':
        args.browser = true;
        break;
      case '-y':
      case '--yolo':
        args.yolo = true;
        break;
      case '--ask':
        args.ask = true;
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
        args.tokenBudget = number(0, 100000000);
        break;
      case '--review':
        args.review = true;
        break;
      case '--free':
        args.free = true;
        break;
      case '--opencode-key':
        args.opencodeKey = value();
        break;
      default:
        fail(`Unknown option: ${arg}\n`);
        process.exit(2);
    }
  }

  return args;
}

function printHelp(): void {
  say(`Vaelen GUI ${VERSION} — standalone window for the harness.

Usage:
  vaelen-gui [options]

Options:
  -C, --workspace <dir>   Project root (default: current directory)
  -m, --model <name>      Model id
      --base-url <url>    OpenAI-compatible endpoint
      --api-key <key>     API key
      --port <n>          Port on 127.0.0.1 (default: 47821)
      --context-budget <n>  Tokens before compaction (default: 80% of the model window)
      --no-open           Do not open a window
      --browser           Open in the default browser instead of an app window
      --ask               Show approval cards for writes and non-read-only commands
      --no-verify         Do not run project checks after edits
      --no-subagents      Disable the task tool
      --no-mcp            Do not connect MCP servers
      --no-audit          Do not write .vaelen/audit.jsonl
      --pro               Pro mode: longer verify window, more subagents
      --free              Use OpenCode's free DeepSeek (needs --opencode-key)
      --opencode-key <key>  OpenCode key for free models
  -y, --yolo              Skip approval prompts (already the default)
  -h, --help              Show this help
  -v, --version           Print version

Commands run without prompting by default. Disk, boot, registry, service,
account, and OS-directory operations are always refused.

The UI is served on localhost with a random access token in the URL. The app
window is a chromeless Edge/Chrome window with its own profile, not a tab.
`);
}

class Hub {
  readonly #clients = new Set<ServerResponse>();

  get size(): number {
    return this.#clients.size;
  }

  add(client: ServerResponse): void {
    this.#clients.add(client);
  }

  remove(client: ServerResponse): void {
    this.#clients.delete(client);
  }

  send(client: ServerResponse, event: Record<string, unknown>): void {
    client.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  broadcast(event: Record<string, unknown>): void {
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of this.#clients) client.write(frame);
  }
}

class WebUi implements Ui {
  readonly #hub: Hub;

  constructor(hub: Hub) {
    this.#hub = hub;
  }

  text(delta: string): void {
    this.#hub.broadcast({ type: 'text', text: delta });
  }

  endText(): void {
    this.#hub.broadcast({ type: 'text-end' });
  }

  toolStart(name: string, args: Record<string, unknown>): void {
    this.#hub.broadcast({ type: 'tool-start', name, args });
  }

  toolOutput(chunk: string): void {
    this.#hub.broadcast({ type: 'tool-output', text: chunk });
  }

  toolEnd(name: string, content: string, isError: boolean): void {
    this.#hub.broadcast({ type: 'tool-end', name, content, isError });
  }

  info(message: string): void {
    this.#hub.broadcast({ type: 'notice', level: 'info', message });
  }

  warn(message: string): void {
    this.#hub.broadcast({ type: 'notice', level: 'warn', message });
  }

  error(message: string): void {
    this.#hub.broadcast({ type: 'error', message });
  }
}

/** Streams one chat's output; every frame is tagged so other chats ignore it. */
class ChatUi implements Ui {
  readonly #hub: Hub;
  readonly #chat: { id: string; partial: string };

  constructor(hub: Hub, chat: { id: string; partial: string }) {
    this.#hub = hub;
    this.#chat = chat;
  }

  text(delta: string): void {
    this.#chat.partial += delta;
    this.#hub.broadcast({ type: 'text', chatId: this.#chat.id, text: delta });
  }

  endText(): void {
    this.#chat.partial = '';
    this.#hub.broadcast({ type: 'text-end', chatId: this.#chat.id });
  }

  toolStart(name: string, args: Record<string, unknown>): void {
    this.#hub.broadcast({ type: 'tool-start', chatId: this.#chat.id, name, args });
  }

  toolOutput(chunk: string): void {
    this.#hub.broadcast({ type: 'tool-output', chatId: this.#chat.id, text: chunk });
  }

  toolEnd(name: string, content: string, isError: boolean): void {
    this.#hub.broadcast({ type: 'tool-end', chatId: this.#chat.id, name, content, isError });
  }

  info(message: string): void {
    this.#hub.broadcast({ type: 'notice', chatId: this.#chat.id, level: 'info', message });
  }

  warn(message: string): void {
    this.#hub.broadcast({ type: 'notice', chatId: this.#chat.id, level: 'warn', message });
  }

  error(message: string): void {
    this.#hub.broadcast({ type: 'error', chatId: this.#chat.id, message });
  }
}

/** An error that carries the HTTP status the request deserves. */
class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Request body too large');
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.trim() === '') return {};
  const parsed: unknown = JSON.parse(raw);
  // A bare string, number, or array makes every later `body.x` read a 500.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, 'Request body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function detectImageMime(data: Buffer): string | undefined {
  const ascii = (start: number, end: number): string => data.subarray(start, end).toString('ascii');
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.length >= 6 && (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a')) return 'image/gif';
  if (data.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  return undefined;
}

function imageExtension(mime: string): string {
  if (mime === 'image/jpeg') return '.jpg';
  if (mime === 'image/webp') return '.webp';
  if (mime === 'image/gif') return '.gif';
  return '.png';
}

function extractPdfText(data: Buffer): string {
  try {
    const raw = data.toString('latin1');
    const parts: string[] = [];
    const paren = /\(([\s\S]*?)\)/g;
    let m: RegExpExecArray | null;
    while ((m = paren.exec(raw)) !== null && parts.join('').length < 200000) {
      const s = m[1]?.replace(/\\([\\()])/g, '$1').replace(/\\n/g, '\n') ?? '';
      if (s.trim() !== '') parts.push(s);
    }
    const out = parts.join(' ').replace(/\s+/g, ' ').trim();
    return out !== '' ? out : '[PDF attached: no extractable text found]';
  } catch { return '[PDF attached: could not extract text]'; }
}

function safeAttachmentName(name: unknown): string {
  if (typeof name !== 'string' || name.trim() === '') return 'attachment';
  return name.trim().replace(/[\r\n]/g, ' ').slice(0, 120);
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(payload));
}

/** A packaged exe defaults to its own folder; the node-run dev server uses cwd. */
function defaultWorkspace(): string {
  const packaged = !/^node(\.exe)?$/i.test(basename(process.execPath));
  return packaged ? dirname(process.execPath) : process.cwd();
}

/** Chromium binaries that can host a chromeless app window, most likely first. */
function chromiumCandidates(): string[] {
  if (process.platform === 'win32') {
    const programFiles = process.env['ProgramFiles'] ?? 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
    const localAppData = process.env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local');
    return [
      join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ];
  }
  if (process.platform === 'darwin') {
    return [
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ];
  }
  return [
    '/usr/bin/microsoft-edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
}

/**
 * Opens a standalone window: a Chromium app window with no address bar, tabs, or
 * browser UI, running from its own profile so it is not tied to the user's
 * browsing session. Returns false when no Chromium binary is available.
 */
function openAppWindow(url: string): boolean {
  const binary = chromiumCandidates().find((candidate) => existsSync(candidate));
  if (!binary) return false;

  const profile = join(homedir(), '.vaelen', 'window');
  try {
    mkdirSync(profile, { recursive: true });
  } catch {
    // A read-only home still allows the window; the profile just will not persist.
  }

  try {
    const child = spawn(
      binary,
      [
        `--app=${url}`,
        `--user-data-dir=${profile}`,
        '--window-size=1180,860',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-features=Translate,MediaRouter',
      ],
      { detached: true, stdio: 'ignore' },
    );
    child.on('error', () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** Last resort: hand the URL to whatever the OS considers the default browser. */
function openInBrowser(url: string): void {
  const command =
    process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    // The printed URL is enough if the launcher is unavailable.
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  if (args.version) {
    say(`${VERSION}\n`);
    return;
  }

  // Whether the project folder was chosen on the command line, which decides
  // whether startup may reopen a chat from a different one.
  const workspaceChosen = typeof args.workspace === 'string' && args.workspace.trim() !== '';

  const config: Config = loadConfig({
    workspace: args.workspace ?? defaultWorkspace(),
    model: args.free && !args.model ? 'deepseek-v4.1-flash-free' : args.model,
    baseUrl: args.free ? 'https://opencode.ai/inference/openai/v1' : args.baseUrl,
    apiKey: args.apiKey,
    // `undefined` lets VAELEN_YOLO apply; passing `false` would mask it.
    yolo: args.yolo || undefined,
    autoApprove: args.ask ? false : undefined,
    contextBudget: args.contextBudget,
    verify: args.noVerify ? false : undefined,
    subagents: args.noSubagents ? false : undefined,
    mcp: args.noMcp ? false : undefined,
    audit: args.noAudit ? false : undefined,
    pro: args.pro ? true : undefined,
    fallbackModel: args.fallbackModel,
    tokenBudget: args.tokenBudget,
    opencodeKey: args.opencodeKey,
    reviewMode: args.review ? true : undefined,
  });

  const hub = new Hub();
  const ui = new WebUi(hub);
  const token = randomUUID();
  // Servers connect once per launch, before the first chat builds its prompt.
  const mcp: McpManager | undefined = config.mcp
    ? await connectMcpServers(config.workspace, { onWarn: (message) => ui.warn(message) })
    : undefined;
  if (mcp && mcp.tools.length > 0) {
    ui.info(`MCP: ${mcp.tools.length} tool(s) from ${mcp.clients.length} server(s)`);
  }
  // Images are served back to the window by id, never by user-supplied path.
  const attachmentFiles = new Map<string, { path: string; mime: string }>();

  /**
   * One chat owns its transcript, its session file, its turn, its steering queue,
   * and its pending approvals. `activeChat` is only the one the window is looking
   * at; every other chat keeps running on its own.
   */
  interface Chat {
    id: string;
    messages: Message[];
    session?: Session;
    /** Each chat owns its project: the folder its tools, checks, and logs use. */
    workspace: string;
    /** The repository this chat has open, or null for a plain folder. */
    repo: RepoRef | null;
    /** The folder "Close repository" returns this chat to. */
    home: string;
    busy: boolean;
    timeMs: number;
    controller?: AbortController;
    steering: string[];
    /** Assistant text streamed but not yet committed to a message, for reattaching. */
    partial: string;
    approvals: Map<string, { settle: (decision: ApprovalDecision) => void; kind: string; target: string }>;
    questions: Map<string, { settle: (answer: string | null) => void; question: string; options: string[] }>;
    permissions: Permissions;
  }

  const chats = new Map<string, Chat>();
  let activeChat: Chat = createChat();
  // Lifetime accounting is shared with the CLI and every earlier session.
  const usageSessionId = randomUUID();
  const usageStats: { lifetime: TokenTotals; sessionTokens: number; sessionRequests: number } = {
    lifetime: loadUsage(),
    sessionTokens: 0,
    sessionRequests: 0,
  };
  // Working time: sum of turn wall-clock, per process + lifetime ledger.
  const timeStats: { lifetime: TimeTotals; sessionMs: number } = {
    lifetime: loadTime(),
    sessionMs: 0,
  };

  async function onUsage(usage: TokenUsage, chat: Chat = activeChat): Promise<void> {
    usageStats.sessionTokens += usage.totalTokens;
    usageStats.sessionRequests += 1;
    if (config.tokenBudget > 0 && usageStats.sessionTokens > config.tokenBudget) {
      hub.broadcast({ type: 'notice', level: 'warn', message: `token budget exceeded (${usageStats.sessionTokens.toLocaleString()} > ${config.tokenBudget.toLocaleString()})` });
    }
    usageStats.lifetime = await recordUsage({
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
      estimated: usage.estimated,
      model: config.model,
      // The ledger records the project the request was actually made against.
      workspace: chat.workspace,
      session: usageSessionId,
    });
    hub.broadcast({
      type: 'usage',
      sessionTokens: usageStats.sessionTokens,
      sessionRequests: usageStats.sessionRequests,
      lifetime: usageStats.lifetime,
      ...timeInfo(),
    });
  }
  // Set once the standalone window has been launched, so closing it can end the process.
  let appWindow = false;
  let windowSeen = false;
  let emptyTimer: NodeJS.Timeout | undefined;

  /** A window reload reconnects well within the grace period. */
  function scheduleWindowExit(): void {
    if (!appWindow || !windowSeen || hub.size > 0 || emptyTimer) return;
    emptyTimer = setTimeout(() => {
      emptyTimer = undefined;
      if (windowSeen && hub.size === 0) shutdown();
    }, 10_000);
    emptyTimer.unref();
  }

  /**
   * A new chat starts unsaved; its file appears with the first message. It also
   * starts in a project folder, which is what makes chats independent: two chats
   * can look at two different repositories at the same time.
   */
  function createChat(workspace: string = config.workspace, repo: RepoRef | null = null): Chat {
    const folder = resolve(workspace);
    const chat: Chat = {
      id: '',
      messages: [{ role: 'system', content: buildSystemPrompt(folder, config.readOnly, config.reviewMode, config.allowQuestions) }],
      workspace: folder,
      repo,
      home: folder,
      busy: false,
      timeMs: 0,
      steering: [],
      partial: '',
      approvals: new Map(),
      questions: new Map(),
      permissions: undefined as unknown as Permissions,
    };
    chat.permissions = buildPermissions(chat);
    return chat;
  }

  /** The process config with this chat's project folded in. */
  function chatConfig(chat: Chat): Config {
    return { ...config, workspace: chat.workspace, sessionDir: sessionDirFor(chat.workspace) };
  }

  /** Every folder whose transcripts the rail may show. */
  function workspaceFolders(): string[] {
    const live = [...chats.values()].map((chat) => chat.workspace);
    return knownWorkspaces(config.workspace, [activeChat.workspace, ...live]);
  }

  /**
   * Two paths that name the same folder. Windows folds case and ignores a
   * trailing separator; `resolve` normalizes both before the comparison.
   */
  function samePath(a: string, b: string): boolean {
    const left = resolve(a);
    const right = resolve(b);
    return process.platform === 'win32'
      ? left.toLowerCase() === right.toLowerCase()
      : left === right;
  }

  /**
   * The chat a request means: an explicit id, an id another window is looking
   * at, or the one this process has active. Anything unrecognised is null, so a
   * stale id can never silently act on a different chat.
   */
  function resolveChatTarget(requested: unknown): Chat | null {
    const id = typeof requested === 'string' ? requested.trim() : '';
    if (id === '') return activeChat;
    return chats.get(id) ?? null;
  }

  function denyPending(chat: Chat): void {
    for (const entry of chat.approvals.values()) entry.settle('deny');
    chat.approvals.clear();
    for (const entry of chat.questions.values()) entry.settle(null);
    chat.questions.clear();
  }

  async function approvalHandler(chat: Chat, request: ApprovalRequest): Promise<ApprovalDecision> {
    if (config.yolo) return 'once';
    const id = randomUUID();
    let settle: (decision: ApprovalDecision) => void = () => undefined;
    const decision = new Promise<ApprovalDecision>((resolve) => {
      settle = resolve;
    });
    chat.approvals.set(id, { settle, kind: request.kind, target: request.target });
    hub.broadcast({
      type: 'approval',
      id,
      chatId: chat.id,
      kind: request.kind,
      target: request.target,
    });
    // The rail marks a background chat that is waiting on the user.
    hub.broadcast({ type: 'chats', ...chatState() });

    const timer = setTimeout(() => {
      if (chat.approvals.delete(id)) settle('deny');
    }, 10 * 60_000);
    timer.unref();

    const result = await decision;
    chat.approvals.delete(id);
    clearTimeout(timer);
    hub.broadcast({ type: 'chats', ...chatState() });
    return result;
  }

  async function questionHandler(chat: Chat, request: QuestionRequest): Promise<string | null> {
    const id = randomUUID();
    let settle: (answer: string | null) => void = () => undefined;
    const answer = new Promise<string | null>((resolve) => {
      settle = resolve;
    });
    chat.questions.set(id, { settle, question: request.question, options: request.options });
    hub.broadcast({
      type: 'question',
      id,
      chatId: chat.id,
      question: request.question,
      options: request.options,
    });
    // The rail marks a background chat that is waiting on the user.
    hub.broadcast({ type: 'chats', ...chatState() });

    // A window that never answers must not wedge the turn forever.
    const timer = setTimeout(() => {
      if (chat.questions.delete(id)) settle(null);
    }, 10 * 60_000);
    timer.unref();

    const result = await answer;
    chat.questions.delete(id);
    clearTimeout(timer);
    hub.broadcast({ type: 'chats', ...chatState() });
    return result;
  }

  function buildPermissions(chat: Chat): Permissions {
    return new Permissions({
      workspace: chat.workspace,
      yolo: config.yolo,
      autoApprove: config.autoApprove,
      readOnly: config.readOnly,
      handler: (request) => approvalHandler(chat, request),
    });
  }

  /** True while any chat is mid-turn; global settings and workspace changes wait. */
  function anyBusy(): boolean {
    if (activeChat.busy) return true;
    for (const chat of chats.values()) if (chat.busy) return true;
    return false;
  }

  function currentMode(): 'read' | 'edit' {
    return config.readOnly ? 'read' : 'edit';
  }

  /**
   * Ask toggle: 'ask' lets the model pause with high-level clarifying
   * questions via ask_user; 'auto' hides ask_user so it proceeds with its
   * best guess and notes the assumption. Nothing to do with file approvals.
   */
  function currentAsk(): 'ask' | 'auto' {
    return config.allowQuestions ? 'ask' : 'auto';
  }

  function applyAsk(ask: boolean): void {
    config.allowQuestions = ask;
    // Every chat gets the new prompt, so the change applies to the very next
    // turn: the tool list gains or loses ask_user along with the instruction.
    for (const chat of new Set([activeChat, ...chats.values()])) {
      chat.messages[0] = {
        role: 'system',
        content: buildSystemPrompt(chat.workspace, config.readOnly, config.reviewMode, config.allowQuestions),
      };
    }
  }

  interface ChatSummary {
    id: string;
    title: string;
    updatedAt: string;
    messages: number;
    timeMs?: number;
    /** The project this chat belongs to, so the rail can label and group it. */
    workspace: string;
    /** A turn is running in this chat, even if the window is looking elsewhere. */
    busy: boolean;
    /** The turn is blocked on a permission card the user has not answered. */
    needsApproval: boolean;
  }

  /** A chat is titled after its first prompt; the file itself stays the source of truth. */
  function chatTitle(loaded: Message[]): string {
    const first = loaded.find((message): message is UserMessage => message.role === 'user');
    if (!first) return 'New chat';
    const text = (first.content ?? '').trim();
    if (text !== '') {
      const line = text.split(/\r?\n/).find((part) => part.trim() !== '')?.trim() ?? '';
      if (line !== '') return line.length > 60 ? `${line.slice(0, 60)}…` : line;
    }
    const attachment = first.attachments?.[0]?.name;
    return attachment ? `Attachment: ${attachment}` : 'New chat';
  }

  /**
   * Parsed metadata per transcript. Reading every chat file on every rail event
   * was O(all history); the stamp (mtime + size) invalidates an entry only when
   * its file actually changed.
   */
  const summaryCache = new Map<
    string,
    { stamp: string; summary: Omit<ChatSummary, 'busy' | 'needsApproval'> }
  >();

  /**
   * Parsed transcripts for search. A keystroke must not re-read every session
   * file on disk, so the parse is cached by the same mtime+size stamp the rail
   * uses; a turn that appends invalidates only that chat. Bounded so a window
   * that browsed hundreds of chats does not keep them all in memory.
   */
  const transcriptCache = new Map<string, { stamp: string; messages: Message[] }>();
  const TRANSCRIPT_CACHE_LIMIT = 24;

  /** Parses one transcript, reusing the cached copy when the file has not changed. */
  function cachedTranscript(key: string, path: string, stamp: string): Message[] | null {
    const cached = transcriptCache.get(key);
    if (cached?.stamp === stamp) {
      // Refresh recency: Map keeps insertion order, so re-insert on a hit.
      transcriptCache.delete(key);
      transcriptCache.set(key, cached);
      return cached.messages;
    }
    let messages: Message[];
    try {
      messages = Session.load(path).filter((message) => message.role !== 'system');
    } catch {
      transcriptCache.delete(key);
      return null;
    }
    transcriptCache.delete(key);
    transcriptCache.set(key, { stamp, messages });
    if (transcriptCache.size > TRANSCRIPT_CACHE_LIMIT) {
      const oldest = transcriptCache.keys().next().value;
      if (oldest !== undefined) transcriptCache.delete(oldest);
    }
    return messages;
  }

  /** Search every transcript the window knows about, newest chats first. */
  function searchTranscripts(raw: string, limit: number): Record<string, unknown> {
    const chats: {
      id: string;
      title: string;
      project: string;
      updatedAt: string;
      messages: Message[];
    }[] = [];

    for (const folder of workspaceFolders()) {
      const dir = sessionDirFor(folder);
      let names: string[];
      try {
        names = readdirSync(dir).filter((name) => name.endsWith('.jsonl'));
      } catch {
        continue;
      }
      for (const name of names) {
        const path = join(dir, name);
        const info = statSync(path, { throwIfNoEntry: false });
        if (!info?.isFile()) continue;
        const messages = cachedTranscript(`${dir.toLowerCase()}|${name}`, path, `${info.mtimeMs}:${info.size}`);
        if (messages === null || messages.length === 0) continue;
        chats.push({
          id: name.replace(/\.jsonl$/, ''),
          title: chatTitle(messages),
          project: folder,
          updatedAt: info.mtime.toISOString(),
          messages,
        });
      }
    }

    // Newest first, so a capped result set favours recent work.
    chats.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const outcome = searchChats(raw, chats, limit);
    return {
      query: raw,
      results: outcome.results,
      truncated: outcome.truncated,
      chatsScanned: outcome.chatsScanned,
      parsed: outcome.query,
    };
  }

  /** Saved chats, newest first. Empty transcripts (crashed before a message) are ignored. */
  function chatSummaries(): ChatSummary[] {
    const summaries: ChatSummary[] = [];
    // Every project the window knows about: chats are per folder, so the rail is
    // the union of those folders' transcripts rather than one session directory.
    for (const folder of workspaceFolders()) {
      const dir = sessionDirFor(folder);
      let names: string[];
      try {
        names = readdirSync(dir).filter((name) => name.endsWith('.jsonl'));
      } catch {
        continue;
      }

      for (const name of names) {
        if (summaries.length >= 200) break;
        const path = join(dir, name);
        const info = statSync(path, { throwIfNoEntry: false });
        if (!info || !info.isFile()) continue;
        const id = name.replace(/\.jsonl$/, '');
        // The same file name can exist in two projects, so the cache is keyed by folder too.
        const key = `${dir.toLowerCase()}|${name}`;
        const stamp = `${info.mtimeMs}:${info.size}`;
        let cached = summaryCache.get(key);
        if (cached?.stamp !== stamp) {
          let loaded: Message[] = [];
          try {
            loaded = Session.load(path).filter((message) => message.role !== 'system');
          } catch {
            summaryCache.delete(key);
            continue;
          }
          if (loaded.length === 0) {
            summaryCache.delete(key);
            continue;
          }
          cached = {
            stamp,
            summary: {
              id,
              title: chatTitle(loaded),
              updatedAt: info.mtime.toISOString(),
              messages: loaded.length,
              workspace: folder,
            },
          };
          summaryCache.set(key, cached);
          // Bound memory across many workspaces; the rail only shows 200 entries.
          if (summaryCache.size > 400) {
            const oldest = summaryCache.keys().next().value;
            if (oldest !== undefined) summaryCache.delete(oldest);
          }
        }
        if (!cached) continue;
        const live = chats.get(id);
        summaries.push({
          ...cached.summary,
          timeMs: live?.timeMs ?? 0,
          busy: live?.busy === true,
          needsApproval: (live?.approvals.size ?? 0) > 0 || (live?.questions.size ?? 0) > 0,
        });
      }
    }

    return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** Resolves a chat id to its file, refusing anything that could escape the folder. */
  function chatFile(id: string): { path: string; workspace: string } | null {
    if (!/^[A-Za-z0-9._-]+$/.test(id) || id.startsWith('.') || id.includes('..')) return null;
    // A chat lives in the project it was created in, so the id is searched there
    // rather than assumed to belong to the workspace this process started in.
    for (const folder of workspaceFolders()) {
      const path = join(sessionDirFor(folder), `${id}.jsonl`);
      if (existsSync(path)) return { path, workspace: folder };
    }
    return null;
  }

  /**
   * Deleted chats are moved next to the session folder instead of unlinked, so
   * one click can bring them back. The folder is invisible to the tab list.
   */
  function trashDirectory(workspace: string): string {
    return join(dirname(sessionDirFor(workspace)), 'trash');
  }

  interface Trashed {
    name: string;
    workspace: string;
    at: number;
  }

  /** Trashed chats across every known project, newest deletion first. */
  const trashMemo: { at: number; entries: Trashed[] } = { at: 0, entries: [] };

  function trashedNames(): Trashed[] {
    // Every turn, approval, and question broadcasts chatState(); scanning every
    // project's trash directory on each one was wasted I/O.
    if (Date.now() - trashMemo.at < 1_000) return trashMemo.entries;
    const trashed: Trashed[] = [];
    for (const folder of workspaceFolders()) {
      const trash = trashDirectory(folder);
      let names: string[];
      try {
        names = readdirSync(trash).filter((name) => name.endsWith('.jsonl'));
      } catch {
        continue;
      }
      for (const name of names) {
        const info = statSync(join(trash, name), { throwIfNoEntry: false });
        if (info?.isFile()) trashed.push({ name, workspace: folder, at: info.mtimeMs });
      }
    }
    trashMemo.at = Date.now();
    trashMemo.entries = trashed.sort((a, b) => b.at - a.at);
    return trashMemo.entries;
  }

  /** Deleting or recovering a chat changes the trash immediately. */
  function forgetTrashMemo(): void {
    trashMemo.at = 0;
  }

  /** Everything the rail needs: tabs, the active one, and whether undo is available. */
  function chatState(): { chats: ChatSummary[]; activeChatId: string | null; recoverable: number } {
    return { chats: chatSummaries(), activeChatId: activeChat.id || null, recoverable: trashedNames().length };
  }

  function pendingQuestions(chat: Chat): { id: string; question: string; options: string[] }[] {
    return [...chat.questions.entries()].map(([id, entry]) => ({
      id,
      question: entry.question,
      options: entry.options,
    }));
  }

  /** The snapshot the window renders when it opens or switches to a chat. */
  function chatSnapshot(chat: Chat): Record<string, unknown> {
    return {
      type: 'chat',
      id: chat.id || null,
      title: chatTitle(chat.messages.slice(1)),
      messages: chat.messages.slice(1),
      partial: chat.partial,
      busy: chat.busy,
      pendingApprovals: [...chat.approvals.entries()].map(([id, entry]) => ({
        id,
        kind: entry.kind,
        target: entry.target,
      })),
      pendingQuestions: pendingQuestions(chat),
      chatTimeMs: chat.timeMs,
      workspace: chat.workspace,
      repo: chat.repo,
      ...usage(chat),
    };
  }

  function broadcastChat(chat: Chat): void {
    hub.broadcast(chatSnapshot(chat));
    hub.broadcast({ type: 'chats', ...chatState() });
  }

  /** Bounds memory: idle chats beyond a dozen are closed, never the viewed or running one. */
  function pruneChats(): void {
    if (chats.size <= 12) return;
    for (const [id, chat] of chats) {
      if (chats.size <= 12) break;
      if (chat === activeChat || chat.busy) continue;
      void chat.session?.close();
      chats.delete(id);
    }
  }

  /** The repository picker: what is open (if anything) and what was open before. */
  function repoState(): { repo: RepoRef | null; history: ReturnType<typeof loadHistory> } {
    // The picker follows the chat being viewed: projects are per chat now.
    return { repo: activeChat.repo, history: loadHistory() };
  }

  /** True when the window is already looking at a fresh, untouched chat. */
  function isFreshChat(chat: Chat): boolean {
    return chat.id === '' && !chat.busy && chat.messages.length === 1 && chat.steering.length === 0;
  }

  /** Points the window at a fresh, unsaved chat; other chats keep running. */
  function newChat(): { chat: Chat; alreadyNew: boolean } {
    if (isFreshChat(activeChat)) {
      broadcastChat(activeChat);
      return { chat: activeChat, alreadyNew: true };
    }
    // A new chat continues in the project the window is already looking at.
    activeChat = createChat(activeChat.workspace, activeChat.repo);
    pruneChats();
    broadcastChat(activeChat);
    return { chat: activeChat, alreadyNew: false };
  }

  /** Moves a saved chat to the trash. Returns false when the id is unknown. */
  function deleteChat(id: string): boolean {
    const live = chats.get(id);
    if (live?.busy) return false;
    const found = chatFile(id);
    if (!found) return false;
    const { path, workspace } = found;
    try {
      mkdirSync(trashDirectory(workspace), { recursive: true });
      renameSync(path, join(trashDirectory(workspace), basename(path)));
    } catch {
      return false;
    }
    chats.delete(id);
    forgetTrashMemo();
    summaryCache.delete(`${sessionDirFor(workspace).toLowerCase()}|${basename(path)}`);
    void live?.session?.close();
    // Deleting the viewed chat leaves the window on a fresh conversation.
    if (activeChat.id === id) newChat();
    return true;
  }

  /** Moves a trashed chat back into the rail; undefined restores the newest one. */
  function recoverChat(id?: string): { id: string; title: string } | null {
    const trashed = trashedNames();
    const entry =
      id === undefined
        ? trashed[0]
        : trashed.find((candidate) => candidate.name.replace(/\.jsonl$/, '') === id);
    if (!entry) return null;

    const { name, workspace } = entry;
    const dir = sessionDirFor(workspace);
    const base = name.replace(/\.jsonl$/, '');
    let target = join(dir, name);
    for (let attempt = 1; existsSync(target); attempt += 1) {
      // Never overwrite a live chat, even if a filename somehow collides.
      target = join(dir, `${base}-recovered-${attempt}.jsonl`);
    }

    try {
      mkdirSync(dir, { recursive: true });
      renameSync(join(trashDirectory(workspace), name), target);
    } catch {
      return null;
    }

    forgetTrashMemo();
    summaryCache.delete(`${dir.toLowerCase()}|${basename(target)}`);
    const restored = basename(target).replace(/\.jsonl$/, '');
    let title = 'Recovered chat';
    try {
      title = chatTitle(Session.load(target).filter((message) => message.role !== 'system'));
    } catch {
      // The title is cosmetic; recovery already succeeded.
    }
    return { id: restored, title };
  }

  /**
   * Points the window at a saved chat. A chat that is already live is reused, so
   * switching to a running chat attaches to it instead of reloading stale disk state.
   */
  function openChat(id: string, broadcast: boolean): boolean {
    const live = chats.get(id);
    if (live) {
      activeChat = live;
      pruneChats();
      if (broadcast) broadcastChat(live);
      return true;
    }

    const found = chatFile(id);
    if (!found) return false;
    const { path, workspace } = found;

    // Reuse the parse cache: switching back to a recently viewed chat must not
    // re-read a multi-megabyte transcript and stall every other chat's stream.
    const info = statSync(path, { throwIfNoEntry: false });
    if (!info?.isFile()) return false;
    const dir = dirname(path);
    const cached = cachedTranscript(
      `${dir.toLowerCase()}|${basename(path)}`,
      path,
      `${info.mtimeMs}:${info.size}`,
    );
    if (cached === null) return false;
    // Copy the array: the chat appends to it, and the cache must stay pristine.
    const loaded = cached.slice();
    repairToolCalls(loaded);

    // The transcript's own folder decides which project the chat belongs to.
    const chat = createChat(workspace);
    chat.id = id;
    chat.messages.push(...loaded);
    try {
      chat.session = Session.open(path);
    } catch {
      chat.session = undefined;
    }
    chats.set(id, chat);
    activeChat = chat;
    pruneChats();

    if (broadcast) broadcastChat(chat);
    return true;
  }

  /**
   * Reopens the most recently used chat, so closing the window loses nothing.
   * The rail is newest-first across every known project and a chat carries its
   * own folder, so reopening one also reopens its project; the folder is skipped
   * only when it no longer exists, where every tool call would fail.
   *
   * An explicit `--workspace` overrides that: being told which project to open
   * and then landing in a chat from a different folder is confusing, and every
   * tool then runs somewhere the user did not ask for.
   */
  function restoreLatestChat(): void {
    const usable = chatSummaries().filter((chat) => existsSync(chat.workspace));
    const latest = workspaceChosen
      ? usable.find((chat) => samePath(chat.workspace, config.workspace))
      : usable[0];
    if (latest) openChat(latest.id, false);
  }

  /** The session file appears with the first message of a new chat. */
  function ensureSession(chat: Chat): Session | undefined {
    if (chat.session) {
      if (chat.id) chats.set(chat.id, chat);
      return chat.session;
    }
    try {
      const created = Session.create(sessionDirFor(chat.workspace), {
        model: config.model,
        workspace: chat.workspace,
      });
      chat.session = created;
      chat.id = basename(created.path).replace(/\.jsonl$/, '');
      // The rail spans projects, so a folder is registered as soon as it has a chat.
      recordWorkspace(chat.workspace);
      chats.set(chat.id, chat);
      pruneChats();
    } catch (error) {
      ui.warn(`Session logging disabled: ${(error as Error).message}`);
      chat.session = undefined;
    }
    return chat.session;
  }

  /** Validates and stores the attachments sent with a chat request. */
  function storeAttachments(raw: unknown, chat: Chat = activeChat): Attachment[] {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) throw new Error('attachments must be an array');
    if (raw.length > MAX_ATTACHMENTS) throw new Error(`At most ${MAX_ATTACHMENTS} files can be attached`);

    const stored: Attachment[] = [];
    let total = 0;

    for (const item of raw) {
      if (typeof item !== 'object' || item === null) throw new Error('Invalid attachment');
      const record = item as Record<string, unknown>;
      const name = safeAttachmentName(record.name);

      if (record.kind === 'text') {
        if (typeof record.content !== 'string') throw new Error(`Attachment "${name}" has no content`);
        if (record.content.length > MAX_TEXT_CHARS) {
          throw new Error(`Attachment "${name}" is too large (max ${MAX_TEXT_CHARS.toLocaleString()} characters)`);
        }
        const size = Buffer.byteLength(record.content, 'utf8');
        total += size;
        if (total > MAX_TOTAL_BYTES) throw new Error('Attachments are too large');
        stored.push({ id: randomUUID(), name, kind: 'text', mime: 'text/plain', size, content: record.content });
        continue;
      }

      if (record.kind === 'image') {
        if (typeof record.data !== 'string') throw new Error(`Attachment "${name}" has no image data`);
        const base64 = record.data.replace(/^data:[^;]+;base64,/, '');
        const bytes = Buffer.from(base64, 'base64');
        if (bytes.length === 0) throw new Error(`Attachment "${name}" is empty`);
        if (bytes.length > MAX_IMAGE_BYTES) throw new Error(`Attachment "${name}" is too large (max 8 MB)`);
        const mime = detectImageMime(bytes);
        if (!mime) throw new Error(`Attachment "${name}" is not a supported image (PNG, JPEG, WebP, GIF)`);
        total += bytes.length;
        if (total > MAX_TOTAL_BYTES) throw new Error('Attachments are too large');

        const id = randomUUID();
        const directory = join(chat.workspace, '.vaelen', 'attachments');
        mkdirSync(directory, { recursive: true });
        const absolute = join(directory, `${id}${imageExtension(mime)}`);
        writeFileSync(absolute, bytes);
        // Bound memory across long-lived windows; disk stays the source of truth.
        if (attachmentFiles.size >= 200) attachmentFiles.clear();
        attachmentFiles.set(id, { path: absolute, mime });
        stored.push({
          id,
          name,
          kind: 'image',
          mime,
          size: bytes.length,
          file: relative(chat.workspace, absolute).replace(/\\/g, '/'),
        });
        continue;
      }

      if (record.kind === 'pdf' || (typeof record.data === 'string' && name.toLowerCase().endsWith('.pdf'))) {
        const base64 = String(record.data ?? '').replace(/^data:[^;]+;base64,/, '');
        const bytes = Buffer.from(base64, 'base64');
        if (bytes.length > MAX_IMAGE_BYTES) throw new Error(`Attachment "${name}" is too large (max 8 MB)`);
        const text = extractPdfText(bytes).slice(0, MAX_TEXT_CHARS);
        total += Buffer.byteLength(text, 'utf8');
        if (total > MAX_TOTAL_BYTES) throw new Error('Attachments are too large');
        stored.push({ id: randomUUID(), name, kind: 'text', mime: 'application/pdf', size: bytes.length, content: text });
        continue;
      }
      throw new Error('Attachment kind must be "image", "text", or "pdf"');
    }

    return stored;
  }

  /**
   * Uploaded images are in memory; images from reopened chats are on disk.
   * Both are served by id, never by a client-supplied path.
   */
  function storedAttachment(id: string): { path: string; mime: string } | undefined {
    const known = attachmentFiles.get(id);
    if (known && existsSync(known.path)) return known;
    if (!/^[0-9a-f-]{36}$/.test(id)) return undefined;

    const directory = join(activeChat.workspace, '.vaelen', 'attachments');
    const extensions: [string, string][] = [
      ['.png', 'image/png'],
      ['.jpg', 'image/jpeg'],
      ['.webp', 'image/webp'],
      ['.gif', 'image/gif'],
    ];
    for (const [extension, mime] of extensions) {
      const path = join(directory, `${id}${extension}`);
      if (existsSync(path)) {
        const found = { path, mime };
        attachmentFiles.set(id, found);
        return found;
      }
    }
    return undefined;
  }

  // Reopen the last chat before the window connects; a reload or restart shows
  // the conversation where it left off.
  recordWorkspace(config.workspace);
  restoreLatestChat();

  /** Interrupts every chat's turn; used before a workspace or repository change. */
  function stopAllChats(): void {
    for (const chat of new Set([activeChat, ...chats.values()])) {
      chat.controller?.abort();
      denyPending(chat);
    }
  }

  /**
   * Points one chat at another project. Only that chat is affected: its
   * transcript starts over in the new folder, and every other chat keeps its own
   * project, its own session file, and its own running turn.
   */
  function setChatProject(chat: Chat, workspace: string, repo: RepoRef | null): string {
    const folder = resolve(workspace);
    chat.workspace = folder;
    chat.repo = repo;
    chat.home = repo ? chat.home : folder;
    chat.messages = [{ role: 'system', content: buildSystemPrompt(folder, config.readOnly, config.reviewMode, config.allowQuestions) }];
    chat.partial = '';
    chat.steering = [];
    denyPending(chat);
    // The old transcript belongs to the old folder; a new file starts in the new one.
    void chat.session?.close();
    chat.session = undefined;
    if (chat.id !== '') chats.delete(chat.id);
    chat.id = '';
    chat.permissions = buildPermissions(chat);
    recordWorkspace(folder);
    return folder;
  }

  async function startTurn(
    chat: Chat,
    text: string,
    attachments: Attachment[] = [],
    requestId?: string,
  ): Promise<void> {
    if (chat.busy) return;
    chat.busy = true;
    // Refresh the prompt so edits to AGENTS.md (and newly registered MCP tools)
    // apply from the next message, not the next launch.
    chat.messages[0] = { role: 'system', content: buildSystemPrompt(chat.workspace, config.readOnly, config.reviewMode, config.allowQuestions) };
    const chatSession = ensureSession(chat);
    // A pasted key is stopped at the door: it never enters the transcript, the
    // request, or the echo the window renders.
    const safeText = redactSecrets(text);
    const userMessage: UserMessage = { role: 'user', content: safeText };
    if (attachments.length > 0) userMessage.attachments = attachments;
    chat.messages.push(userMessage);
    chatSession?.append(userMessage);
    hub.broadcast({
      type: 'user',
      chatId: chat.id,
      requestId,
      text: safeText,
      attachments: attachments.map(({ id, name, kind, mime, size }) => ({ id, name, kind, mime, size })),
    });
    // The first message of a new chat creates its file; every turn refreshes the
    // rail, because the title and timestamp come from the transcript.
    hub.broadcast({ type: 'chats', ...chatState() });

    const controller = new AbortController();
    chat.controller = controller;
    const chatUi = new ChatUi(hub, chat);
    const turnStartedAt = Date.now();
    hub.broadcast({ type: 'turn-start', chatId: chat.id, startedAt: turnStartedAt, ...usage(chat) });

    try {
      const runOptions = {
        // The agent gets this chat's project, so tools, checks, and checkpoints
        // all resolve inside the folder the chat belongs to.
        config: chatConfig(chat),
        permissions: chat.permissions,
        messages: chat.messages,
        ui: chatUi,
        session: chatSession,
        signal: controller.signal,
        onUsage: (usage: TokenUsage) => onUsage(usage, chat),
        steering: { drain: () => chat.steering.splice(0) },
        ask: (request: QuestionRequest) => questionHandler(chat, request),
      };
      let reason = await runAgent(runOptions);
      // Guidance that arrived during the last request gets its own leg, so the
      // turn does not end with an unanswered steer in the transcript.
      while (reason === 'complete' && chat.steering.length > 0 && !controller.signal.aborted) {
        reason = await runAgent(runOptions);
      }
      const durationMs = Date.now() - turnStartedAt;
      timeStats.sessionMs += durationMs;
      chat.timeMs += durationMs;
      timeStats.lifetime = await recordTime(durationMs, usageSessionId);
      hub.broadcast({ type: 'turn-end', chatId: chat.id, reason, durationMs, chatTimeMs: chat.timeMs, ...usage(chat), ...chatState() });
    } catch (error) {
      const message = error instanceof ProviderError ? error.message : (error as Error).message;
      hub.broadcast({ type: 'error', chatId: chat.id, message });
      // The transcript may have grown before the failure; refresh the meter.
      const durationMs = Date.now() - turnStartedAt;
      timeStats.sessionMs += durationMs;
      chat.timeMs += durationMs;
      timeStats.lifetime = await recordTime(durationMs, usageSessionId);
      hub.broadcast({ type: 'turn-end', chatId: chat.id, reason: 'error', durationMs, chatTimeMs: chat.timeMs, ...usage(chat), ...chatState() });
    } finally {
      // A steer that raced an abort or a step limit still joins the transcript,
      // so the next message is answered with the guidance in context.
      const late = chat.steering.splice(0);
      for (const message of late) {
        const steer: UserMessage = { role: 'user', content: redactSecrets(message) };
        chat.messages.push(steer);
        chat.session?.append(steer);
      }
      // Nothing was answered, so the prompt is not part of the conversation: drop
      // it instead of replaying it to the model on the next turn.
      if (late.length === 0 && chat.partial === '' && chat.messages[chat.messages.length - 1] === userMessage) {
        retractEmptyTurn(chat, userMessage, requestId);
      }
      chat.busy = false;
      chat.controller = undefined;
      chat.partial = '';
      denyPending(chat);
      hub.broadcast({ type: 'chats', ...chatState() });
    }
  }

  /**
   * A turn that produced no output leaves its prompt in the transcript, where the
   * model would read it as an unanswered message the user actually sent. Take it
   * back out of the transcript and hand the text to the composer, so a failed send
   * costs the user nothing.
   */
  function retractEmptyTurn(chat: Chat, userMessage: UserMessage, requestId?: string): void {
    chat.messages.pop();
    chat.session?.retractLast();
    // Only the window showing this chat may rewrite its transcript and composer.
    if (chat !== activeChat) return;
    broadcastChat(chat);
    hub.broadcast({
      type: 'send-failed',
      chatId: chat.id,
      requestId,
      text: userMessage.content,
      attachments: userMessage.attachments?.length ?? 0,
    });
  }

  /**
   * Context estimate, its budget and window, plus lifetime totals. Every event
   * that refreshes the top bar carries all of it, so the window never polls.
   */
  function timeInfo(): {
    lifetimeMs: number;
    lifetimeTurns: number;
    sessionMs: number;
    timeLedger: string;
  } {
    return {
      lifetimeMs: timeStats.lifetime.totalMs,
      lifetimeTurns: timeStats.lifetime.turns,
      sessionMs: timeStats.sessionMs,
      timeLedger: timeFilePath(),
    };
  }

  function usage(chat: Chat = activeChat): {
    tokens: number;
    budget: number;
    modelWindow: number;
    lifetime: TokenTotals;
    sessionTokens: number;
    sessionRequests: number;
    usageLedger: string;
    lifetimeMs: number;
    lifetimeTurns: number;
    sessionMs: number;
    timeLedger: string;
  } {
    return {
      tokens: estimateTokens(chat.messages),
      budget: config.contextBudget,
      modelWindow: contextWindowFor(config.model),
      lifetime: usageStats.lifetime,
      sessionTokens: usageStats.sessionTokens,
      sessionRequests: usageStats.sessionRequests,
      usageLedger: usageFilePath(),
      ...timeInfo(),
    };
  }

  function state(): Record<string, unknown> {
    return {
      model: config.model,
      baseUrl: config.baseUrl,
      // The active chat's project, not the process default.
      workspace: activeChat.workspace,
      repo: activeChat.repo,
      ...chatState(),
      budget: config.contextBudget,
      modelWindow: contextWindowFor(config.model),
      // 0 means the turn is not capped by steps.
      maxSteps: config.maxSteps,
      tokens: estimateTokens(activeChat.messages),
      lifetime: usageStats.lifetime,
      usageLedger: usageFilePath(),
      ...timeInfo(),
      mode: currentMode(),
      ask: currentAsk(),
      busy: activeChat.busy,
      hasKey: config.apiKey !== '',
      needsKey: requiresApiKey(config.baseUrl) && config.apiKey === '',
      verify: config.verify,
      subagents: config.subagents,
      mcp: mcp?.statuses ?? [],
      undoable: listCheckpoints(activeChat.workspace).length,
    };
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');

      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(html);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/favicon.ico') {
        res.writeHead(204).end();
        return;
      }

      if (!url.pathname.startsWith('/api/')) {
        res.writeHead(404).end();
        return;
      }

      const supplied = req.headers['x-vaelen-token'] ?? url.searchParams.get('token');
      if (supplied !== token) {
        json(res, 401, { error: 'Invalid or missing access token' });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });
        res.write(': connected\n\n');
        hub.add(res);
        windowSeen = true;
        if (emptyTimer) {
          clearTimeout(emptyTimer);
          emptyTimer = undefined;
        }
        hub.send(res, {
          type: 'hello',
          model: config.model,
          baseUrl: config.baseUrl,
          workspace: activeChat.workspace,
          repo: activeChat.repo,
          ...chatState(),
          history: activeChat.messages.slice(1),
          partial: activeChat.partial,
          pendingApprovals: [...activeChat.approvals.entries()].map(([id, entry]) => ({
            id,
            kind: entry.kind,
            target: entry.target,
          })),
          pendingQuestions: pendingQuestions(activeChat),
          mode: currentMode(),
          ask: currentAsk(),
          // A reload mid-turn must not come back as idle.
          busy: activeChat.busy,
          hasKey: config.apiKey !== '',
          needsKey: requiresApiKey(config.baseUrl) && config.apiKey === '',
          verify: config.verify,
          subagents: config.subagents,
          maxSteps: config.maxSteps,
          mcp: mcp?.statuses ?? [],
          undoable: listCheckpoints(activeChat.workspace).length,
          ...usage(),
        });
        req.on('close', () => {
          hub.remove(res);
          scheduleWindowExit();
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/state') {
        json(res, 200, state());
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/chats') {
        json(res, 200, chatState());
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/search') {
        const raw = (url.searchParams.get('q') ?? '').slice(0, 400);
        const limitParam = Number(url.searchParams.get('limit') ?? '50');
        const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(200, Math.floor(limitParam)) : 50;
        json(res, 200, searchTranscripts(raw, limit));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/chats') {
        // Other chats keep running; the window just moves to a fresh one.
        const { chat, alreadyNew } = newChat();
        json(res, 200, { ok: true, id: chat.id || null, alreadyNew });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/chats/delete') {
        const body = await readJson(req);
        const id = typeof body.id === 'string' ? body.id.trim() : '';
        if (chats.get(id)?.busy) {
          json(res, 409, { error: 'cannot delete a chat while its turn is running' });
          return;
        }
        if (!deleteChat(id)) {
          json(res, 404, { error: 'chat not found' });
          return;
        }
        hub.broadcast({ type: 'chats', ...chatState() });
        json(res, 200, { ok: true, id, ...chatState() });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/chats/recover') {
        const body = await readJson(req);
        const id = typeof body.id === 'string' && body.id.trim() !== '' ? body.id.trim() : undefined;
        const restored = recoverChat(id);
        if (!restored) {
          json(res, 404, { error: 'nothing to recover' });
          return;
        }
        hub.broadcast({ type: 'chats', ...chatState() });
        json(res, 200, { ok: true, ...restored, ...chatState() });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/chats/switch') {
        const body = await readJson(req);
        const id = typeof body.id === 'string' ? body.id.trim() : '';
        if (!openChat(id, true)) {
          json(res, 404, { error: 'chat not found' });
          return;
        }
        json(res, 200, { ok: true, id, busy: activeChat.busy });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/chat') {
        const body = await readJson(req);
        // An empty chat id means "the chat the window is looking at", which is how
        // an unsaved chat addresses itself before it has a session file. An id that
        // is not live is refused: it must never fall back to another chat.
        const chat = resolveChatTarget(body.chatId);
        if (!chat) {
          json(res, 404, { error: 'chat not found' });
          return;
        }
        if (chat.busy) {
          json(res, 409, { error: 'a turn is already running in this chat — steer it or wait' });
          return;
        }
        const message = typeof body.message === 'string' ? body.message.trim() : '';
        let attachments: Attachment[];
        try {
          attachments = storeAttachments(body.attachments, chat);
        } catch (error) {
          json(res, 400, { error: (error as Error).message });
          return;
        }
        if (message === '' && attachments.length === 0) {
          json(res, 400, { error: 'message or attachments are required' });
          return;
        }
        const requestId = typeof body.requestId === 'string' ? body.requestId.slice(0, 80) : undefined;
        // startTurn creates the session file before its first await, so chat.id
        // is final by the time the response and the user event are written.
        void startTurn(chat, message, attachments, requestId);
        json(res, 202, { ok: true, chatId: chat.id || null, attachments: attachments.length });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/steer') {
        const body = await readJson(req);
        const chat = resolveChatTarget(body.chatId);
        if (!chat) {
          json(res, 404, { error: 'chat not found' });
          return;
        }
        if (!chat.busy) {
          json(res, 409, { error: 'no turn is running in this chat — send the message normally' });
          return;
        }
        const message = typeof body.message === 'string' ? body.message.trim() : '';
        if (message === '') {
          json(res, 400, { error: 'steering needs a message' });
          return;
        }
        if (message.length > 8_000) {
          json(res, 400, { error: 'steering messages are limited to 8,000 characters' });
          return;
        }
        chat.steering.push(redactSecrets(message));
        // Show it immediately; the agent picks it up at the next step boundary.
        hub.broadcast({ type: 'user', chatId: chat.id, text: message, steer: true });
        json(res, 202, { ok: true, queued: chat.steering.length });
        return;
      }

      const attachmentMatch = /^\/api\/attachment\/([0-9a-f-]+)$/.exec(url.pathname);
      if (req.method === 'GET' && attachmentMatch) {
        const stored = storedAttachment(attachmentMatch[1] ?? '');
        if (!stored) {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200, {
          'content-type': stored.mime,
          'content-length': statSync(stored.path).size,
          'cache-control': 'private, max-age=3600',
        });
        createReadStream(stored.path).pipe(res);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/mode') {
        if (anyBusy()) {
          json(res, 409, { error: 'cannot change mode while a turn is running' });
          return;
        }
        const body = await readJson(req);
        if (body.mode !== 'read' && body.mode !== 'edit') {
          json(res, 400, { error: "mode must be 'read' or 'edit'" });
          return;
        }
        config.readOnly = body.mode === 'read';
        // Every chat gets the new prompt and permission set, so the change applies
        // to the very next tool call, not just the next process.
        for (const chat of new Set([activeChat, ...chats.values()])) {
          chat.messages[0] = {
            role: 'system',
            content: buildSystemPrompt(chat.workspace, config.readOnly, config.reviewMode, config.allowQuestions),
          };
          chat.permissions = buildPermissions(chat);
        }
        hub.broadcast({ type: 'mode', mode: currentMode() });
        json(res, 200, { ok: true, mode: currentMode() });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/ask') {
        if (anyBusy()) {
          json(res, 409, { error: 'cannot change ask mode while a turn is running' });
          return;
        }
        const body = await readJson(req);
        let ask: boolean | undefined;
        if (typeof body.ask === 'boolean') ask = body.ask;
        else if (body.mode === 'ask') ask = true;
        else if (body.mode === 'auto') ask = false;
        if (ask === undefined) {
          json(res, 400, { error: "ask must be a boolean or mode must be 'ask' or 'auto'" });
          return;
        }
        applyAsk(ask);
        hub.broadcast({ type: 'ask', ask: currentAsk() });
        json(res, 200, { ok: true, ask: currentAsk() });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/answer') {
        const body = await readJson(req);
        const id = typeof body.id === 'string' ? body.id : '';
        const requested = body.answer;
        if (requested !== null && typeof requested !== 'string') {
          json(res, 400, { error: 'answer must be a string or null' });
          return;
        }
        if (typeof requested === 'string' && requested.length > 8_000) {
          json(res, 400, { error: 'answers are limited to 8,000 characters' });
          return;
        }
        const entry = [...new Set([activeChat, ...chats.values()])]
          .map((chat) => chat.questions.get(id))
          .find((candidate) => candidate !== undefined);
        if (!entry) {
          json(res, 404, { error: 'no pending question with that id' });
          return;
        }
        entry.settle(requested);
        json(res, 200, { ok: true });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/approve') {
        const body = await readJson(req);
        const id = typeof body.id === 'string' ? body.id : '';
        const decision: ApprovalDecision =
          body.decision === 'always' ? 'always' : body.decision === 'once' ? 'once' : 'deny';
        const entry = [...new Set([activeChat, ...chats.values()])]
          .map((chat) => chat.approvals.get(id))
          .find((candidate) => candidate !== undefined);
        if (!entry) {
          json(res, 404, { error: 'no pending approval with that id' });
          return;
        }
        entry.settle(decision);
        json(res, 200, { ok: true, decision });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/abort') {
        const body = await readJson(req);
        const chat = resolveChatTarget(body.chatId);
        if (!chat) {
          json(res, 404, { error: 'chat not found' });
          return;
        }
        chat.controller?.abort();
        denyPending(chat);
        json(res, 200, { ok: true });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/workspace') {
        if (anyBusy()) {
          json(res, 409, { error: 'cannot switch workspace while a turn is running' });
          return;
        }
        const body = await readJson(req);
        const requested = typeof body.path === 'string' ? body.path.trim() : '';
        if (requested === '') {
          json(res, 400, { error: 'path is required' });
          return;
        }
        const resolved = resolve(requested);
        const info = statSync(resolved, { throwIfNoEntry: false });
        if (!info || !info.isDirectory()) {
          json(res, 400, { error: `not a directory: ${resolved}` });
          return;
        }
        // Per chat: the folder change applies to the chat this request names.
        const target = resolveChatTarget(body.chatId);
        if (!target) {
          json(res, 404, { error: 'chat not found' });
          return;
        }
        if (target.busy) {
          json(res, 409, { error: 'cannot change this chat\'s project while its turn is running' });
          return;
        }
        // Pointing a chat at the folder it already has is not a change, and the
        // work below resets the transcript: report success and touch nothing.
        if (samePath(target.workspace, resolved)) {
          json(res, 200, { ok: true, workspace: target.workspace, chatId: target.id || null, unchanged: true });
          return;
        }
        // A plain folder is not a repository, so the chat drops out of repo mode.
        const folder = setChatProject(target, resolved, null);
        broadcastChat(target);
        hub.broadcast({ type: 'workspace', chatId: target.id, workspace: folder, repo: null });
        hub.broadcast({ type: 'repos', chatId: target.id, ...repoState() });
        json(res, 200, { ok: true, workspace: folder, chatId: target.id || null });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/repos') {
        // ?chatId= lets the window ask about the chat it is showing rather than
        // whichever chat this process happens to have active.
        const requested = url.searchParams.get('chatId') ?? '';
        const chat = resolveChatTarget(requested);
        json(res, 200, {
          repo: chat ? chat.repo : activeChat.repo,
          workspace: chat ? chat.workspace : activeChat.workspace,
          chatId: chat?.id || null,
          history: loadHistory(),
          gh: await ghStatus(),
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/repos/mine') {
        const mine = await listOwnRepos();
        json(res, mine.ok ? 200 : 502, mine);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/repos/open') {
        const body = await readJson(req);
        const target = resolveChatTarget(body.chatId);
        if (!target) {
          json(res, 404, { error: 'chat not found' });
          return;
        }
        if (target.busy) {
          json(res, 409, { error: 'cannot open a repository in a chat whose turn is running' });
          return;
        }
        const repo = parseRepo(body.repo);
        if (!repo) {
          json(res, 400, { error: 'Use owner/name, e.g. octocat/hello-world' });
          return;
        }

        const opened = await openRepo(repo);
        if (!opened.ok) {
          json(res, 400, { error: opened.error || 'Could not clone that repository' });
          return;
        }

        setChatProject(target, opened.path, repo);
        const history = recordRepo(repo, opened.path);
        broadcastChat(target);
        hub.broadcast({ type: 'workspace', chatId: target.id, workspace: target.workspace, repo });
        hub.broadcast({ type: 'repos', chatId: target.id, repo, history });
        json(res, 200, {
          ok: true,
          repo,
          label: repoLabel(repo),
          path: opened.path,
          chatId: target.id || null,
          cloned: opened.method !== 'local',
          history,
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/repos/close') {
        const body = await readJson(req);
        const target = resolveChatTarget(body.chatId);
        if (!target) {
          json(res, 404, { error: 'chat not found' });
          return;
        }
        if (target.busy) {
          json(res, 409, { error: 'cannot close a repository in a chat whose turn is running' });
          return;
        }
        if (target.repo) {
          // Back to the folder this chat was in before it opened a clone.
          setChatProject(target, target.home, null);
          broadcastChat(target);
          hub.broadcast({ type: 'workspace', chatId: target.id, workspace: target.workspace, repo: null });
          hub.broadcast({ type: 'repos', chatId: target.id, ...repoState() });
        }
        json(res, 200, { ok: true, workspace: target.workspace, chatId: target.id || null });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/repos/forget') {
        const body = await readJson(req);
        const repo = parseRepo(body.repo);
        if (!repo) {
          json(res, 400, { error: 'Use owner/name, e.g. octocat/hello-world' });
          return;
        }
        const history = forgetRepo(repo);
        hub.broadcast({ type: 'repos', repo: activeChat.repo, history });
        json(res, 200, { ok: true, history });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/clear') {
        if (activeChat.busy) {
          json(res, 409, { error: 'cannot clear this chat while its turn is running' });
          return;
        }
        activeChat.messages.splice(1);
        activeChat.session?.markCleared();
        hub.broadcast({ type: 'cleared', chatId: activeChat.id, ...usage(activeChat), ...chatState() });
        json(res, 200, { ok: true });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/undo') {
        if (anyBusy()) {
          json(res, 409, { error: 'cannot undo while a turn is running' });
          return;
        }
        const restored = restoreLatest(activeChat.workspace);
        if (!restored) {
          json(res, 404, { error: 'nothing to undo' });
          return;
        }
        const remaining = listCheckpoints(activeChat.workspace).length;
        const message =
          restored.files.length > 0
            ? `Undid the last turn — restored ${restored.files.join(', ')}`
            : `Undid the last turn — ${restored.id} had no files left to restore`;
        hub.broadcast({ type: 'notice', level: 'info', message });
        json(res, 200, { ok: true, ...restored, remaining });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/audit') {
        const requested = Number(url.searchParams.get('limit') ?? '20');
        const limit = Number.isFinite(requested) && requested > 0 ? Math.min(200, Math.floor(requested)) : 20;
        const audit = new AuditLog(activeChat.workspace, '');
        json(res, 200, { path: audit.path, entries: audit.tail(limit) });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/config') {
        const body = await readJson(req);
        const patch: {
          baseUrl?: string;
          model?: string;
          apiKey?: string;
          opencodeKey?: string;
          contextBudget?: number;
          maxSteps?: number;
          verify?: boolean;
        } = {};

        if (typeof body.baseUrl === 'string' && body.baseUrl.trim() !== '') {
          const candidate = body.baseUrl.trim().replace(/\/+$/, '');
          let parsed: URL;
          try {
            parsed = new URL(candidate);
          } catch {
            json(res, 400, { error: `Invalid base URL: ${candidate}` });
            return;
          }
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            json(res, 400, { error: 'The base URL must start with http:// or https://' });
            return;
          }
          config.baseUrl = candidate;
          patch.baseUrl = config.baseUrl;
        }
        if (typeof body.model === 'string' && body.model.trim() !== '') {
          config.model = body.model.trim().slice(0, 120);
          // An unpinned budget follows the new model's window.
          if (!config.contextBudgetPinned) config.contextBudget = defaultContextBudget(config.model);
          patch.model = config.model;
        }
        if (body.contextBudget !== undefined) {
          const budget = body.contextBudget;
          if (
            typeof budget !== 'number' ||
            !Number.isFinite(budget) ||
            budget <= 1000 ||
            budget > MAX_CONTEXT_BUDGET
          ) {
            json(res, 400, {
              error: `Context budget must be between 1,001 and ${MAX_CONTEXT_BUDGET.toLocaleString()} tokens`,
            });
            return;
          }
          config.contextBudget = Math.floor(budget);
          config.contextBudgetPinned = true;
          patch.contextBudget = config.contextBudget;
        }
        if (typeof body.apiKey === 'string' && body.apiKey.trim() !== '') {
          config.apiKey = body.apiKey.trim();
          patch.apiKey = config.apiKey;
        }
        if (typeof body.opencodeKey === 'string' && body.opencodeKey.trim() !== '') {
          config.opencodeKey = body.opencodeKey.trim();
          patch.opencodeKey = config.opencodeKey;
          if (config.apiKey === '') {
            config.baseUrl = 'https://opencode.ai/inference/openai/v1';
            patch.baseUrl = config.baseUrl;
            if (config.model === 'deepseek-flash') config.model = 'deepseek-v4.1-flash-free';
            patch.model = config.model;
            config.apiKey = config.opencodeKey;
            patch.apiKey = config.apiKey;
          }
        }
        if (body.maxSteps !== undefined) {
          const steps = body.maxSteps;
          if (
            typeof steps !== 'number' ||
            !Number.isFinite(steps) ||
            steps < 0 ||
            steps > MAX_STEPS_CEILING
          ) {
            json(res, 400, {
              error: `Steps per turn must be 1–${MAX_STEPS_CEILING.toLocaleString()}, or 0 for no limit`,
            });
            return;
          }
          // 0 is the documented "no cap"; the rest is clamped to the ceiling.
          config.maxSteps = normalizeMaxSteps(steps);
          patch.maxSteps = config.maxSteps;
        }
        if (typeof body.verify === 'boolean') {
          config.verify = body.verify;
          patch.verify = body.verify;
        }
        if (typeof body.ask === 'boolean') {
          applyAsk(body.ask);
        } else if (body.ask === 'ask') {
          applyAsk(true);
        } else if (body.ask === 'auto') {
          applyAsk(false);
        }

        // Persist on save so every new session reconnects without the user.
        let persisted = false;
        if (Object.keys(patch).length > 0) {
          try {
            saveFileConfig(patch);
            persisted = true;
          } catch (error) {
            ui.warn(`Could not save ${configFilePath()}: ${(error as Error).message}`);
          }
        }

        hub.broadcast({
          type: 'config',
          model: config.model,
          baseUrl: config.baseUrl,
          persisted,
          verify: config.verify,
          ask: currentAsk(),
          maxSteps: config.maxSteps,
          ...usage(),
        });
        json(res, 200, {
          ok: true,
          model: config.model,
          baseUrl: config.baseUrl,
          budget: config.contextBudget,
          maxSteps: config.maxSteps,
          persisted,
        });
        return;
      }

      json(res, 404, { error: 'not found' });
    } catch (error) {
      if (error instanceof HttpError) {
        json(res, error.status, { error: error.message });
        return;
      }
      if (error instanceof SyntaxError) {
        json(res, 400, { error: 'Malformed JSON body' });
        return;
      }
      json(res, 500, { error: (error as Error).message });
    }
  });

  server.on('listening', () => {
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : DEFAULT_PORT;
    const url = `http://127.0.0.1:${port}/?token=${token}`;
    const redacted = url.replace(token, '***');
    const startup =
      `Vaelen GUI ${VERSION}\nworkspace: ${config.workspace}\nmodel: ${config.model}\n` +
      `key: ${config.apiKey ? 'configured' : 'not set'}\nconfig: ${configFilePath()}\n`;
    // The log outlives the process, so it gets the URL without the token.
    say(`${startup}url: ${url}\nVAELEN_URL=${url}\n`, `${startup}url: ${redacted}\nVAELEN_URL=${redacted}\n`);
    if (!args.noOpen) {
      appWindow = !args.browser && openAppWindow(url);
      if (!appWindow) openInBrowser(url);
    }
  });

  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE' && args.port === undefined) {
      // Another copy is already running on the default port; fall back to any free port.
      fail(`Port ${DEFAULT_PORT} is busy, using a random port instead.\n`);
      server.listen(0, '127.0.0.1');
      return;
    }
    fail(`Vaelen GUI failed: ${error.message}\n`);
    process.exit(1);
  });

  server.listen(args.port ?? DEFAULT_PORT, '127.0.0.1');

  const shutdown = (): void => {
    const sessions = [...new Set([activeChat, ...chats.values()])].map((chat) => {
      chat.controller?.abort();
      denyPending(chat);
      return chat.session?.close() ?? Promise.resolve();
    });
    mcp?.close();
    server.close();
    void Promise.allSettled(sessions).finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 800).unref();
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function crashLog(error: unknown): void {
  try {
    const path = join(homedir(), '.vaelen', 'crash.log');
    mkdirSync(dirname(path), { recursive: true });
    const stack = error instanceof Error ? error.stack ?? error.message : String(error);
    appendFileSync(path, `${new Date().toISOString()} VaelenGUI crash\n${stack}\n\n`);
  } catch { /* crash logging is best-effort */ }
}

process.on('uncaughtException', (error) => { crashLog(error); });
process.on('unhandledRejection', (reason) => { crashLog(reason); });

main().catch((error: unknown) => {
  crashLog(error);
  fail(`Vaelen GUI failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
