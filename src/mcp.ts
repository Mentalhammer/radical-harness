import { createHash } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { registerTools } from './tools/index.ts';
import type { JsonSchema, ToolSpec } from './types.ts';

/**
 * A small MCP client: stdio servers and streamable-HTTP servers, tools only.
 * It is intentionally not a full SDK — enough JSON-RPC to connect to the
 * filesystem, database, browser, and issue-tracker servers people use.
 */
export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  /** Trust this server's tools without an approval prompt in --ask mode. */
  readOnly?: boolean;
  timeoutMs?: number;
  disabled?: boolean;
}

export interface McpStatus {
  name: string;
  transport: 'stdio' | 'http';
  tools: number;
  error?: string;
}

interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: { readOnlyHint?: boolean };
}

interface JsonRpcResponse {
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

interface Transport {
  request(method: string, params: unknown, timeoutMs: number): Promise<unknown>;
  notify(method: string, params: unknown): Promise<void>;
  close(): void;
}

class StdioTransport implements Transport {
  #child: ChildProcessWithoutNullStreams;
  #pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  #nextId = 1;
  #stderr = '';
  #closed = false;

  constructor(config: McpServerConfig) {
    if (!config.command) throw new Error('stdio server needs a "command"');
    const env: NodeJS.ProcessEnv = { ...process.env, ...(config.env ?? {}) };
    this.#child = spawn(config.command, config.args ?? [], {
      cwd: config.cwd,
      env,
      windowsHide: true,
      // On Windows, npx/uvx are .cmd shims; the shell resolves them.
      shell: process.platform === 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.#child.stderr.on('data', (chunk: Buffer) => {
      this.#stderr = `${this.#stderr}${chunk.toString()}`.slice(-2_000);
    });
    this.#child.on('error', (error) => this.#fail(error));
    this.#child.on('close', () => this.#fail(new Error(`server exited${this.#stderr ? `: ${this.#stderr}` : ''}`)));

    const lines = createInterface({ input: this.#child.stdout });
    lines.on('line', (line) => this.#onLine(line));
  }

  #onLine(line: string): void {
    if (line.trim() === '') return;
    let message: JsonRpcResponse & { method?: string; params?: unknown };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      return;
    }
    if (message.id !== undefined && this.#pending.has(Number(message.id))) {
      const entry = this.#pending.get(Number(message.id))!;
      this.#pending.delete(Number(message.id));
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
      return;
    }
    // Servers may ping; answer so the connection stays healthy.
    if (message.method !== undefined && message.id !== undefined) {
      this.#write({ jsonrpc: '2.0', id: message.id, result: {} });
    }
  }

  #write(payload: unknown): void {
    if (this.#closed) return;
    try {
      this.#child.stdin.write(`${JSON.stringify(payload)}\n`);
    } catch {
      this.#fail(new Error('server stdin is closed'));
    }
  }

  #fail(error: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const entry of this.#pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.#pending.clear();
  }

  request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.#closed) return Promise.reject(new Error('server is not running'));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      timer.unref();
      this.#pending.set(id, { resolve, reject, timer });
      this.#write({ jsonrpc: '2.0', id, method, params });
    });
  }

  async notify(method: string, params: unknown): Promise<void> {
    this.#write({ jsonrpc: '2.0', method, params });
  }

  close(): void {
    this.#fail(new Error('closed'));
    try {
      this.#child.stdin.end();
      this.#child.kill();
    } catch {
      // Already gone.
    }
  }
}

class HttpTransport implements Transport {
  #url: string;
  #headers: Record<string, string>;
  #sessionId: string | undefined;
  #nextId = 1;

  constructor(config: McpServerConfig) {
    if (!config.url) throw new Error('HTTP server needs a "url"');
    this.#url = config.url;
    this.#headers = config.headers ?? {};
  }

  async request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = this.#nextId++;
    const message = await this.#post({ jsonrpc: '2.0', id, method, params }, timeoutMs);
    if (message && typeof message === 'object' && 'error' in message) {
      const error = (message as JsonRpcResponse).error;
      throw new Error(error?.message ?? `${method} failed`);
    }
    return (message as JsonRpcResponse | null)?.result;
  }

  async notify(method: string, params: unknown): Promise<void> {
    await this.#post({ jsonrpc: '2.0', method, params }, 15_000).catch(() => undefined);
  }

  async #post(payload: unknown, timeoutMs: number): Promise<unknown> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...this.#headers,
    };
    if (this.#sessionId) headers['mcp-session-id'] = this.#sessionId;

    const response = await fetch(this.#url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const session = response.headers.get('mcp-session-id');
    if (session) this.#sessionId = session;
    if (response.status === 202 || response.status === 204) return null;
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);

    const contentType = response.headers.get('content-type') ?? '';
    const body = await response.text();
    if (contentType.includes('text/event-stream')) {
      for (const line of body.split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '' || data === '[DONE]') continue;
        try {
          const message = JSON.parse(data) as JsonRpcResponse;
          if (message.id !== undefined) return message;
        } catch {
          // Keep looking for the matching frame.
        }
      }
      return null;
    }
    if (body.trim() === '') return null;
    return JSON.parse(body) as JsonRpcResponse;
  }

  close(): void {
    // HTTP is stateless from our side; the server expires the session.
  }
}

export class McpClient {
  readonly name: string;
  readonly config: McpServerConfig;
  #transport: Transport;
  #tools: McpToolInfo[] = [];
  #timeoutMs: number;

  private constructor(name: string, config: McpServerConfig, transport: Transport) {
    this.name = name;
    this.config = config;
    this.#transport = transport;
    this.#timeoutMs = config.timeoutMs !== undefined && config.timeoutMs >= 1000 ? config.timeoutMs : 60_000;
  }

  static async connect(name: string, config: McpServerConfig): Promise<McpClient> {
    const transport: Transport = config.url ? new HttpTransport(config) : new StdioTransport(config);
    const client = new McpClient(name, config, transport);
    const timeout = config.timeoutMs ?? 20_000;
    try {
      await transport.request(
        'initialize',
        {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'vaelen', version: '0.1.0' },
        },
        timeout,
      );
      await transport.notify('notifications/initialized', {});
      client.#tools = await client.#listTools();
      return client;
    } catch (error) {
      transport.close();
      throw error;
    }
  }

  get tools(): McpToolInfo[] {
    return this.#tools;
  }

  async #listTools(): Promise<McpToolInfo[]> {
    const tools: McpToolInfo[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const result = (await this.#transport.request(
        'tools/list',
        cursor === undefined ? {} : { cursor },
        this.#timeoutMs,
      )) as { tools?: McpToolInfo[]; nextCursor?: string } | null;
      for (const tool of result?.tools ?? []) if (tool?.name) tools.push(tool);
      if (!result?.nextCursor) break;
      cursor = result.nextCursor;
    }
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    const result = (await this.#transport.request(
      'tools/call',
      { name, arguments: args },
      this.#timeoutMs,
    )) as
      | { content?: { type?: string; text?: string }[]; structuredContent?: unknown; isError?: boolean }
      | null;
    const parts = (result?.content ?? [])
      .map((part) => (part.type === 'text' && typeof part.text === 'string' ? part.text : `[${part.type ?? 'content'}]`))
      .filter((part) => part !== '');
    const text = parts.length > 0
      ? parts.join('\n')
      : result?.structuredContent !== undefined
        ? JSON.stringify(result.structuredContent, null, 2)
        : '(the server returned no content)';
    return { text, isError: result?.isError === true };
  }

  close(): void {
    this.#transport.close();
  }
}

export interface McpManager {
  clients: McpClient[];
  statuses: McpStatus[];
  tools: ToolSpec[];
  /** Closes every stdio server. */
  close(): void;
}

export interface McpConnectOptions {
  /** Overrides config files (used by tests). */
  servers?: Record<string, McpServerConfig>;
  onWarn?: (message: string) => void;
}

export async function connectMcpServers(
  workspace: string,
  options: McpConnectOptions = {},
): Promise<McpManager> {
  const configs = options.servers ?? loadMcpConfig(workspace);
  const clients: McpClient[] = [];
  const statuses: McpStatus[] = [];
  const tools: ToolSpec[] = [];
  const used = new Set<string>();

  for (const [name, config] of Object.entries(configs)) {
    if (!config || config.disabled) continue;
    try {
      const client = await McpClient.connect(name, config);
      clients.push(client);
      statuses.push({
        name,
        transport: config.url ? 'http' : 'stdio',
        tools: client.tools.length,
      });
      for (const info of client.tools) {
        const exposed = exposedName(name, info.name, used);
        tools.push(mcpToolSpec(client, info, exposed));
      }
    } catch (error) {
      const message = `MCP server "${name}" failed: ${(error as Error).message}`;
      statuses.push({ name, transport: config.url ? 'http' : 'stdio', tools: 0, error: (error as Error).message });
      options.onWarn?.(message);
    }
  }

  if (tools.length > 0) registerTools(tools);

  return {
    clients,
    statuses,
    tools,
    close: () => {
      for (const client of clients) client.close();
    },
  };
}

function mcpToolSpec(client: McpClient, info: McpToolInfo, exposed: string): ToolSpec {
  const readOnly = client.config.readOnly === true || info.annotations?.readOnlyHint === true;
  const schema = normalizeSchema(info.inputSchema);
  const description = info.description?.trim() || `${client.name}: ${info.name}`;
  return {
    name: exposed,
    description: `[${client.name}] ${description}`.slice(0, 1_024),
    parameters: schema,
    readOnly,
    async run(args, ctx) {
      if (!readOnly) await ctx.permissions.approveTool(`${client.name}/${info.name}`);
      try {
        const result = await client.callTool(info.name, args);
        return { content: result.text, isError: result.isError, mutated: !readOnly && !result.isError };
      } catch (error) {
        return { content: `MCP ${client.name}/${info.name}: ${(error as Error).message}`, isError: true };
      }
    },
  };
}

function normalizeSchema(input: unknown): JsonSchema {
  if (typeof input === 'object' && input !== null) {
    const candidate = input as { type?: unknown; properties?: unknown; required?: unknown };
    if (candidate.type === 'object' && typeof candidate.properties === 'object' && candidate.properties !== null) {
      return candidate as JsonSchema;
    }
  }
  return { type: 'object', properties: {}, additionalProperties: true };
}

/** MCP names are free-form; provider tool names are [A-Za-z0-9_-] and <=64. */
function exposedName(server: string, tool: string, used: Set<string>): string {
  const clean = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, '_');
  let name = `mcp__${clean(server)}__${clean(tool)}`;
  if (name.length > 64) {
    const hash = createHash('sha1').update(`${server}/${tool}`).digest('hex').slice(0, 6);
    name = `${name.slice(0, 57)}_${hash}`;
  }
  let candidate = name;
  for (let attempt = 2; used.has(candidate); attempt++) {
    const suffix = `_${attempt}`;
    candidate = `${name.slice(0, 64 - suffix.length)}${suffix}`;
  }
  used.add(candidate);
  return candidate;
}

/** User config, then workspace config, with the project winning per server name. */
export function loadMcpConfig(workspace: string): Record<string, McpServerConfig> {
  const home = join(homedir(), '.vaelen', 'mcp.json');
  const project = join(workspace, '.vaelen', 'mcp.json');
  return { ...readMcpFile(home), ...readMcpFile(project) };
}

function readMcpFile(path: string): Record<string, McpServerConfig> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { mcpServers?: unknown } & Record<string, unknown>;
    const raw = parsed.mcpServers ?? parsed;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
    const servers: Record<string, McpServerConfig> = {};
    for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
      const record = value as Record<string, unknown>;
      servers[name] = {
        command: expandString(record.command),
        args: Array.isArray(record.args) ? record.args.map((item) => expand(String(item))) : undefined,
        env: stringRecord(record.env),
        cwd: expandString(record.cwd),
        url: expandString(record.url),
        headers: stringRecord(record.headers),
        readOnly: record.readOnly === true,
        timeoutMs: typeof record.timeoutMs === 'number' ? record.timeoutMs : undefined,
        disabled: record.disabled === true,
      };
    }
    return servers;
  } catch {
    return {};
  }
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === 'string') out[key] = expand(item);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function expandString(value: unknown): string | undefined {
  return typeof value === 'string' ? expand(value) : undefined;
}

/** `${VAR}` in a config file keeps secrets out of it. */
function expand(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => process.env[name] ?? '');
}
