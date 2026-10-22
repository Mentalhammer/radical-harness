import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export interface Config {
  workspace: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  yolo: boolean;
  /**
   * Run writes and non-read-only commands without asking. On by default; the
   * system-level guard still refuses disk/boot/registry/OS operations.
   */
  autoApprove: boolean;
  /** Read-only sessions can inspect the workspace but cannot write or mutate it. */
  readOnly: boolean;
  /**
   * Whether the model may pause and ask the user clarifying questions via
   * ask_user. Off (Auto) means no questions: it proceeds with its best guess.
   * On (Ask) means it may ask high-level clarifications when ambiguous.
   */
  allowQuestions: boolean;
  maxSteps: number;
  contextBudget: number;
  /** True when the budget came from a flag, env var, or config file instead of the model default. */
  contextBudgetPinned: boolean;
  sessionDir: string;
  /** Run the project's checks automatically after a turn that changed files. */
  verify: boolean;
  /** Explicit checks, replacing auto-discovery. Each entry is one command line. */
  verifyCommands: string[];
  verifyTimeoutMs: number;
  /** Let the model delegate isolated work to child agents with the task tool. */
  subagents: boolean;
  /** Fallback model tried once when the primary returns 429/5xx. */
  fallbackModel: string;
  /** Daily/lifetime token cap (0 = unlimited). Counts input+output estimates. */
  tokenBudget: number;
  /** Prompted review + extra verify when true. */
  reviewMode: boolean;
  /** Connect MCP servers from ~/.vaelen/mcp.json and <workspace>/.vaelen/mcp.json. */
  mcp: boolean;
  /** Append every tool call to <workspace>/.vaelen/audit.jsonl and run local hooks. */
  audit: boolean;
  /** Cap on child agents per turn, so a loop cannot fan out forever. */
  maxSubagents: number;
  /** Pro mode: longer verify window, more subagents, polished review commands. */
  pro: boolean;
  /** OpenCode key for the free `*-free` DeepSeek models (no DeepSeek key needed). */
  opencodeKey: string;
}

/** DeepSeek's models: `deepseek-flash` is currently served by DeepSeek-V4.1-Flash-1017. */
export const DEFAULT_BASE_URL = 'https://api.deepseek.com';
export const DEFAULT_MODEL = 'deepseek-flash';
/** OpenCode's hosted proxy — serves `*-free` DeepSeek models with an OpenCode key. */
export const OPENCODE_BASE_URL = 'https://opencode.ai/inference/openai/v1';
export const FREE_MODEL = 'deepseek-v4.1-flash-free';

/** Advertised context windows, in tokens. Unknown models get the conservative 128k. */
const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  'deepseek-flash': 1_000_000,
  'deepseek-chat': 128_000,
  'deepseek-reasoner': 128_000,
  'deepseek-v4.1-flash': 1_000_000,
  'deepseek-v4.1-flash-free': 1_000_000,
  'deepseek-v4-flash-free': 1_000_000,
};
const FALLBACK_CONTEXT_WINDOW = 128_000;

/**
 * The budget is deliberately a fraction of the window: the rest covers the
 * reply and the error in the chars/4 estimate, which undershoots on code.
 */
const CONTEXT_USABLE_FRACTION = 0.8;

export function contextWindowFor(model: string): number {
  return MODEL_CONTEXT_WINDOWS[model.trim().toLowerCase()] ?? FALLBACK_CONTEXT_WINDOW;
}

/** Budget used when the user has not pinned one. */
export function defaultContextBudget(model: string): number {
  return Math.floor((contextWindowFor(model) * CONTEXT_USABLE_FRACTION) / 1000) * 1000;
}

/** Tool round-trips per turn when nothing else says otherwise. */
export const DEFAULT_MAX_STEPS = 100;
/** A stored step limit of zero means "no cap"; the GUI and `--max-steps 0` use it. */
export const UNLIMITED_STEPS = 0;
/** Upper bound for a finite limit, so a typed 9e9 cannot become one by accident. */
export const MAX_STEPS_CEILING = 100_000;

/**
 * The loop bound for a turn: `Infinity` when the limit is unlimited, so the agent
 * runs until it is done, interrupted, or out of context.
 */
export function stepLimit(maxSteps: number): number {
  return maxSteps > 0 ? Math.min(maxSteps, MAX_STEPS_CEILING) : Number.POSITIVE_INFINITY;
}

export function isUnlimitedSteps(maxSteps: number): boolean {
  return maxSteps <= 0;
}

/**
 * Normalizes a configured limit. Anything missing or unusable falls back to the
 * default; a zero or negative value is the documented way to ask for no cap.
 */
export function normalizeMaxSteps(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MAX_STEPS;
  if (value <= 0) return UNLIMITED_STEPS;
  return Math.min(Math.floor(value), MAX_STEPS_CEILING);
}

interface FileConfig {
  model?: string;
  fallbackModel?: string;
  tokenBudget?: number;
  reviewMode?: boolean;
  baseUrl?: string;
  apiKey?: string;
  maxSteps?: number;
  contextBudget?: number;
  verify?: boolean | string[];
  verifyTimeoutMs?: number;
  subagents?: boolean;
  mcp?: boolean;
  audit?: boolean;
  pro?: boolean;
  opencodeKey?: string;
}

/** `VAELEN_CONFIG` points the config file somewhere else (used by the tests). */
export function configFilePath(): string {
  const override = process.env.VAELEN_CONFIG;
  if (override && override.trim() !== '') return resolve(override.trim());
  return join(homedir(), '.vaelen', 'config.json');
}

type DotEnv = Record<string, string>;

function parseEnvFile(path: string): DotEnv {
  if (!existsSync(path)) return {};
  const values: DotEnv = {};
  try {
    for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (line === '' || line.startsWith('#')) continue;
      const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!match) continue;
      const name = match[1] ?? '';
      let value = (match[2] ?? '').trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      values[name] = value;
    }
  } catch {
    return {};
  }
  return values;
}

/** Keys can also live in .env files, which is where most people already keep them. */
function readDotEnv(workspace: string): DotEnv {
  return {
    ...parseEnvFile(join(homedir(), '.vaelen', '.env')),
    ...parseEnvFile(join(workspace, '.env')),
    ...parseEnvFile(join(workspace, '.env.local')),
  };
}

export function readFileConfig(): FileConfig {
  const path = configFilePath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as FileConfig;
  } catch {
    return {};
  }
}

/**
 * Project-local settings that belong to the repo, not the machine. Only the
 * harness features are read here: credentials stay in the user's config.
 */
function readWorkspaceConfig(workspace: string): FileConfig {
  const path = join(workspace, '.vaelen', 'config.json');
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as FileConfig;
    return {
      verify: parsed.verify,
      verifyTimeoutMs: parsed.verifyTimeoutMs,
      subagents: parsed.subagents,
      mcp: parsed.mcp,
      audit: parsed.audit,
      pro: parsed.pro,
    };
  } catch {
    return {};
  }
}

/**
 * Merges settings into the config file so later sessions pick them up without
 * any flags. Only called when the user explicitly saves a connection.
 */
export function saveFileConfig(patch: FileConfig): FileConfig {
  const path = configFilePath();
  const next: FileConfig = { ...readFileConfig(), ...patch };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return next;
}

function env(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value && value.trim() !== '') return value.trim();
  }
  return undefined;
}

function parseNumber(value: string | undefined): number | undefined {
  // A blank value is "unset", not zero: `VAELEN_MAX_STEPS=` must fall back to the
  // default instead of reading as an explicit "no limit".
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** "0", "false", "no", "off" disable a flag; anything else enables it. */
export function proEnabled(overrides: Partial<Config> & { pro?: boolean }): boolean {
  if (overrides.pro !== undefined) return overrides.pro;
  const env = process.env.VAELEN_PRO;
  if (env !== undefined && env.trim() !== '') return !/^(0|false|no|off)$/i.test(env.trim());
  return false;
}

function envFlag(name: string): boolean | undefined {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') return undefined;
  return !/^(0|false|no|off)$/i.test(value.trim());
}

function verifySettings(
  input: boolean | string[] | undefined,
  environment: string | undefined,
): { enabled: boolean | undefined; commands: string[] } {
  if (Array.isArray(input)) {
    const commands = input.map((command) => command.trim()).filter((command) => command !== '');
    return { enabled: commands.length > 0, commands };
  }
  if (typeof input === 'boolean') return { enabled: input, commands: [] };
  if (environment !== undefined && environment.trim() !== '') {
    if (/^(0|false|no|off)$/i.test(environment.trim())) return { enabled: false, commands: [] };
    if (/^(1|true|yes|on)$/i.test(environment.trim())) return { enabled: true, commands: [] };
    // Any other value is a command line, e.g. VAELEN_VERIFY="npm run typecheck".
    return { enabled: true, commands: [environment.trim()] };
  }
  return { enabled: undefined, commands: [] };
}

/** Hosted providers reject unauthenticated calls; local servers do not. */
export function requiresApiKey(baseUrl: string): boolean {
  return /api\.deepseek\.com|api\.openai\.com|api\.anthropic\.com|opencode\.ai/.test(baseUrl);
}

export function opencodeKeyFromEnv(dotenv: Record<string, string>, file: { opencodeKey?: string }): string {
  return (
    process.env.VAELEN_OPENCODE_KEY?.trim() ||
    process.env.OPENCODE_API_KEY?.trim() ||
    dotenv.VAELEN_OPENCODE_KEY?.trim() ||
    dotenv.OPENCODE_API_KEY?.trim() ||
    file.opencodeKey?.trim() ||
    ''
  );
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const file = readFileConfig();
  const workspace = resolve(overrides.workspace ?? process.cwd());
  const project = readWorkspaceConfig(workspace);
  const dotenv = readDotEnv(workspace);
  const budget =
    overrides.contextBudget ?? parseNumber(env('VAELEN_CONTEXT_BUDGET')) ?? file.contextBudget;
  const steps = overrides.maxSteps ?? parseNumber(env('VAELEN_MAX_STEPS')) ?? file.maxSteps;
  const pinnedBudget = budget !== undefined && budget > 1000 ? budget : undefined;

  const verify = verifySettings(
    overrides.verify !== undefined
      ? overrides.verify
      : Array.isArray(overrides.verifyCommands)
        ? overrides.verifyCommands
        : (project.verify ?? file.verify),
    env('VAELEN_VERIFY'),
  );
  const verifyCommands =
    overrides.verifyCommands && overrides.verifyCommands.length > 0
      ? overrides.verifyCommands
      : verify.commands;
  const verifyTimeout =
    overrides.verifyTimeoutMs ??
    parseNumber(env('VAELEN_VERIFY_TIMEOUT_MS')) ??
    project.verifyTimeoutMs ??
    file.verifyTimeoutMs;
  const maxSubagents = parseNumber(env('VAELEN_MAX_SUBAGENTS'));
  const pro = proEnabled({ pro: overrides.pro ?? project.pro ?? file.pro });
  const opencodeKey = overrides.opencodeKey ?? opencodeKeyFromEnv(dotenv, file);
  const wantFree = envFlag('VAELEN_FREE') === true;
  const deepseekKey =
    overrides.apiKey ??
    env('VAELEN_API_KEY', 'DEEPSEEK_API_KEY', 'OPENAI_API_KEY') ??
    dotenv.VAELEN_API_KEY ??
    dotenv.DEEPSEEK_API_KEY ??
    dotenv.OPENAI_API_KEY ??
    file.apiKey ??
    '';
  const freeActive =
    overrides.baseUrl === OPENCODE_BASE_URL ||
    wantFree ||
    (deepseekKey === '' && opencodeKey !== '');
  const resolvedBase = freeActive
    ? OPENCODE_BASE_URL
    : (overrides.baseUrl ?? env('VAELEN_BASE_URL', 'OPENAI_BASE_URL') ?? dotenv.VAELEN_BASE_URL ?? file.baseUrl ?? DEFAULT_BASE_URL);
  const resolvedModel = freeActive && (overrides.model ?? env('VAELEN_MODEL', 'OPENAI_MODEL') ?? dotenv.VAELEN_MODEL ?? file.model) === undefined
    ? FREE_MODEL
    : (overrides.model ?? env('VAELEN_MODEL', 'OPENAI_MODEL') ?? dotenv.VAELEN_MODEL ?? file.model ?? DEFAULT_MODEL);
  const resolvedKey = freeActive ? opencodeKey : deepseekKey;

  return {
    workspace,
    model: resolvedModel,
    baseUrl: stripTrailingSlash(resolvedBase),
    apiKey: resolvedKey,
    opencodeKey,
    yolo: overrides.yolo ?? env('VAELEN_YOLO') === '1',
    // `VAELEN_ASK=1` (or --ask) restores the approval prompts.
    autoApprove: overrides.autoApprove ?? env('VAELEN_ASK') !== '1',
    readOnly: overrides.readOnly ?? false,
    allowQuestions: overrides.allowQuestions ?? true,
    maxSteps: normalizeMaxSteps(steps),
    contextBudget: pinnedBudget ?? defaultContextBudget(resolvedModel),
    contextBudgetPinned: pinnedBudget !== undefined,
    sessionDir: overrides.sessionDir ?? join(workspace, '.vaelen', 'sessions'),
    verify: overrides.verify ?? verify.enabled ?? true,
    verifyCommands,
    verifyTimeoutMs:
      verifyTimeout !== undefined && verifyTimeout >= 1000
        ? Math.floor(verifyTimeout)
        : pro
          ? 300_000
          : 180_000,
    subagents:
      overrides.subagents ?? envFlag('VAELEN_SUBAGENTS') ?? project.subagents ?? file.subagents ?? true,
    fallbackModel:
      overrides.fallbackModel ??
      env('VAELEN_FALLBACK_MODEL') ??
      file.fallbackModel ??
      (resolvedModel === 'deepseek-reasoner' ? 'deepseek-chat' : 'deepseek-chat'),
    tokenBudget:
      overrides.tokenBudget ?? parseNumber(env('VAELEN_TOKEN_BUDGET')) ?? file.tokenBudget ?? 0,
    reviewMode:
      overrides.reviewMode ?? envFlag('VAELEN_REVIEW') ?? file.reviewMode ?? pro,
    mcp: overrides.mcp ?? envFlag('VAELEN_MCP') ?? project.mcp ?? file.mcp ?? true,
    audit: overrides.audit ?? envFlag('VAELEN_AUDIT') ?? project.audit ?? file.audit ?? true,
    pro,
    maxSubagents:
      maxSubagents !== undefined && maxSubagents >= 0
        ? Math.min(16, Math.floor(maxSubagents))
        : pro
          ? 8
          : 4,
  };
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}
