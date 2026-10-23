import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

export type ApprovalDecision = 'once' | 'always' | 'deny';

export interface ApprovalRequest {
  kind: 'write' | 'bash' | 'tool';
  target: string;
  detail?: string;
}

export type ApprovalHandler = (request: ApprovalRequest) => Promise<ApprovalDecision>;

/**
 * Only an explicit yes approves. Enter, EOF, and unrecognised answers deny:
 * a stray newline (or a closed pipe) must never run a command.
 */
export function parseApprovalAnswer(answer: string): ApprovalDecision {
  const normalized = answer.trim().toLowerCase();
  if (normalized === 'a' || normalized === 'always') return 'always';
  if (normalized === 'y' || normalized === 'yes' || normalized === 'once') return 'once';
  return 'deny';
}

export class PermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermissionError';
  }
}

const READ_ONLY_BINARIES = new Set([
  'ls', 'dir', 'cat', 'head', 'tail', 'wc', 'pwd', 'echo', 'which', 'whoami', 'date',
  'rg', 'grep', 'egrep', 'tree', 'file', 'stat', 'du', 'df', 'basename', 'dirname',
  'realpath', 'sort', 'uniq', 'cut', 'tr', 'jq', 'diff', 'cmp',
]);

const READ_ONLY_GIT = new Set([
  'status', 'diff', 'log', 'show', 'blame', 'rev-parse', 'ls-files', 'shortlog',
  'describe', 'cat-file', 'grep',
]);

// Subcommands that read with no arguments but mutate with others. Allow only the
// explicit inspection forms; everything else needs approval (and read mode blocks it).
function isReadOnlyGit(words: string[]): boolean {
  const sub = words[1] ?? '';
  const arg = words[2] ?? '';
  if (sub === 'branch') {
    return words.length === 2 || ['--list', '-l', '-a', '-r', '-v', '-vv', '--show-current'].includes(arg);
  }
  if (sub === 'tag') return words.length === 2 || ['--list', '-l'].includes(arg);
  if (sub === 'remote') return words.length === 2 || ['-v', '--verbose', 'show', 'get-url'].includes(arg);
  if (sub === 'config') return ['--get', '--get-all', '--get-regexp', '--list', '-l'].includes(arg);
  return READ_ONLY_GIT.has(sub);
}

// Shell builtins that only move the working directory. They cannot write a file
// or run a command, so `cd repo && grep foo src` is inspection, not mutation —
// and the bash tool spawns a fresh shell per call, so the change never outlives
// the command line it appears on.
const NAVIGATION_BINARIES = new Set(['cd', 'pushd', 'popd']);

/** Binaries with a read-only default but flags that write a file or run a command. */
function hasWriteFlag(words: string[]): boolean {
  const bin = words[0] ?? '';
  const rest = words.slice(1);
  if (bin === 'sort') {
    return rest.some((word) => word === '-o' || word.startsWith('--output') || (word.startsWith('-o') && word.length > 2));
  }
  if (bin === 'uniq') {
    // uniq [INPUT [OUTPUT]]: a second positional path is written to.
    return rest.filter((word) => !word.startsWith('-')).length > 1;
  }
  if (bin === 'tree') {
    return rest.some((word) => word === '-o' || word.startsWith('--output') || (word.startsWith('-o') && word.length > 2));
  }
  if (bin === 'date') {
    return rest.some((word) => word === '-s' || word.startsWith('--set') || (word.startsWith('-s') && word.length > 2));
  }
  if (bin === 'rg') {
    return rest.some((word) => word.startsWith('--pre'));
  }
  return false;
}

const DANGEROUS = /(^|\s)(rm|rmdir|mv|dd|mkfs|chmod|chown|shutdown|reboot|sudo|curl|wget)(\s|$)/;

function segments(command: string): string[] {
  return command
    .split(/\r?\n|\r|\|\||&&|[;|]/)
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

/**
 * System-level operations are refused outright, even with auto-approval or
 * --yolo. Everything else runs without a prompt by default. This is a static
 * classifier, not a sandbox: it catches the obvious ways to destroy an OS.
 */
const SYSTEM_BINARIES: Record<string, string> = {
  format: 'disk formatting',
  diskpart: 'disk partitioning',
  fdisk: 'disk partitioning',
  parted: 'disk partitioning',
  wipefs: 'disk wiping',
  mke2fs: 'filesystem creation',
  dd: 'raw disk writes',
  shutdown: 'shutting down the machine',
  reboot: 'rebooting the machine',
  poweroff: 'powering off the machine',
  halt: 'halting the machine',
  bcdedit: 'the boot configuration',
  bootrec: 'the boot configuration',
  sfc: 'Windows system files',
  dism: 'the Windows image',
  vssadmin: 'volume shadow copies',
  wbadmin: 'system backups',
  regedit: 'the registry',
  sudo: 'privilege escalation',
  doas: 'privilege escalation',
  runas: 'privilege escalation',
  takeown: 'ownership changes',
  cipher: 'disk wiping',
};

const MUTATING_BINARIES = new Set([
  'rm', 'rmdir', 'rd', 'del', 'erase', 'mv', 'move', 'cp', 'copy', 'tee', 'touch',
  'mkdir', 'md', 'chmod', 'chown', 'chgrp', 'ln', 'truncate', 'install', 'rsync', 'scp',
]);

const ROOT_TARGETS = new Set([
  '/', '/*', '~', '~/', '$home', '${home}', '%userprofile%', '%homepath%', '%systemroot%', '%windir%',
]);

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** Directories the OS lives in; writes and deletes there are refused. */
function systemRoots(): string[] {
  const roots: string[] = [];
  if (process.platform === 'win32') {
    roots.push(process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows');
    for (const name of ['ProgramFiles', 'ProgramFiles(x86)', 'ProgramData']) {
      const value = process.env[name];
      if (value) roots.push(value);
    }
    roots.push('C:\\Boot', 'C:\\Recovery', 'C:\\System Volume Information');
  } else {
    roots.push('/etc', '/bin', '/sbin', '/usr', '/boot', '/dev', '/proc', '/sys', '/lib', '/lib64', '/root', '/var/lib');
    if (process.platform === 'darwin') roots.push('/System', '/Library', '/private/etc', '/private/var');
  }
  return [...new Set(roots.map(normalizePath).filter((root) => root !== ''))];
}

/** True when `target` is (or lives inside) an operating-system directory. */
export function isSystemPath(target: string, base = process.cwd()): boolean {
  if (typeof target !== 'string' || target.trim() === '') return false;
  const absolute = isAbsolute(target) ? resolve(target) : resolve(base, target);
  const path = normalizePath(realPath(absolute));
  return systemRoots().some((root) => path === root || path.startsWith(`${root}/`));
}

function isRootTarget(word: string): boolean {
  const value = unquote(word).trim().toLowerCase();
  if (ROOT_TARGETS.has(value)) return true;
  // A drive root: C:, C:\, C:/, C:\*
  return /^[a-z]:[\\/]?\*?$/i.test(value);
}

function wordsOf(part: string): string[] {
  return (part.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map(unquote);
}

function unquote(word: string): string {
  return word.replace(/^["']|["']$/g, '');
}

/**
 * Returns a short reason when a command would touch the machine itself, or
 * null when it is ordinary project work.
 */
export function systemRisk(command: string, base = process.cwd()): string | null {
  for (const part of segments(command)) {
    const words = wordsOf(part);
    const bin = basename(words[0] ?? '').toLowerCase();
    if (bin === '') continue;

    const direct =
      SYSTEM_BINARIES[bin] ?? (bin.startsWith('mkfs') ? 'filesystem creation' : undefined);
    if (direct) return direct;

    if (bin === 'reg' && /^(add|delete|import|load|unload|copy|restore|save)$/i.test(words[1] ?? '')) {
      return 'the registry';
    }
    if (bin === 'sc' && /^(create|delete|config|failure|start|stop)$/i.test(words[1] ?? '')) {
      return 'system services';
    }
    if (bin === 'net' && /^(user|localgroup|group|accounts)$/i.test(words[1] ?? '')) {
      return 'local accounts';
    }
    if (bin === 'chkdsk' && words.slice(1).some((word) => /^\/[fr]$/i.test(word))) {
      return 'disk repair';
    }

    // Wrappers are the easy way around a static check: inspect the inner
    // command instead of trusting `bash -c` or `cmd /c`.
    if (bin === 'bash' || bin === 'sh' || bin === 'zsh' || bin === 'dash') {
      const flag = words.findIndex((word) => /^-[a-z]*c[a-z]*$/i.test(word));
      if (flag >= 0) {
        const inner = unquote(words.slice(flag + 1).join(' '));
        const risk = systemRisk(inner, base);
        if (risk) return risk;
      }
    }
    if (bin === 'cmd' || bin === 'command') {
      const flag = words.findIndex((word) => /^\/[ck]$/i.test(word));
      if (flag >= 0) {
        const inner = unquote(words.slice(flag + 1).join(' '));
        const risk = systemRisk(inner, base);
        if (risk) return risk;
      }
    }
    if (bin === 'powershell' || bin === 'pwsh') {
      // The script arrives as one quoted argument; split it so its targets are
      // visible to the same checks.
      const script = unquote(words.slice(1).join(' ')).split(/\s+/);
      for (const word of script) {
        if (isRootTarget(word) || isSystemPath(word, base)) return 'system files';
      }
    }

    const whole = part
      .replace(/(Remove-Item|Move-Item|Copy-Item|New-Item|Set-Content|Add-Content|Clear-Content|Out-File)/gi, ' ')
      .trim();
    if (/\bHKEY_|HKLM:|HKCU:|HKCR:|HKU:|HKCC:/i.test(part)) return 'the registry';
    if (/\b(Format-Volume|Clear-Disk|Initialize-Disk|Remove-Partition|Set-Partition|Stop-Computer|Restart-Computer)\b/i.test(part)) {
      return 'system hardware';
    }

    // Redirection into an OS location: echo x > /etc/hosts.
    for (const match of whole.matchAll(/(?:^|\s)(?:>>?|2>)\s*("[^"]*"|'[^']*'|\S+)/g)) {
      const target = match[1] ?? '';
      if (isRootTarget(target) || isSystemPath(target, base)) return 'system files';
    }

    // A file-changing command aimed at an OS directory or a filesystem root.
    const mutating =
      MUTATING_BINARIES.has(bin) ||
      /^(Remove-Item|Move-Item|Copy-Item|New-Item|Set-Content|Add-Content|Clear-Content|Out-File)$/i.test(words[0] ?? '');
    if (!mutating) continue;

    for (const word of words.slice(1)) {
      if (word === '' || word.startsWith('-')) continue;
      if (isRootTarget(word)) return 'the filesystem root';
      if (isSystemPath(word, base)) return 'system files';
    }
  }

  return null;
}

/** Conservative: anything not provably read-only requires approval. */
export function isReadOnlyCommand(command: string): boolean {
  if (DANGEROUS.test(command)) return false;
  if (/>|<|`|\$\(/.test(command)) return false;

  const parts = segments(command);
  if (parts.length === 0) return false;

  return parts.every((part) => {
    const words = part.split(/\s+/);
    const bin = words[0];
    if (!bin) return false;
    if (NAVIGATION_BINARIES.has(bin)) return true;
    if (bin === 'git') {
      // `--output` turns otherwise-read subcommands into file writers.
      if (words.some((word) => word === '--output' || word.startsWith('--output='))) return false;
      return isReadOnlyGit(words);
    }
    if (bin === 'find') {
      return !/(^|\s)(-delete|-exec|-execdir|-ok|-fprint|-fprint0|-fprintf|-fls)(\s|$)/.test(part);
    }
    if (bin === 'npm' || bin === 'pnpm' || bin === 'yarn' || bin === 'node' || bin === 'npx') {
      // Version and help flags never mutate; everything else may install or run code.
      if (words.slice(1).every((word) => /^(-v|--version|-h|--help)$/.test(word) || word === '')) return true;
      return false;
    }
    if (hasWriteFlag(words)) return false;
    return READ_ONLY_BINARIES.has(bin);
  });
}

/**
 * realpath() that also works for paths that do not exist yet (write_file):
 * canonicalize the deepest existing ancestor and keep the rest as given.
 */
function realPath(target: string): string {
  let current = target;
  let tail = '';
  for (;;) {
    try {
      const real = realpathSync.native(current);
      return tail === '' ? real : resolve(real, tail);
    } catch {
      const parent = dirname(current);
      if (parent === current) return target;
      tail = tail === '' ? basename(current) : join(basename(current), tail);
      current = parent;
    }
  }
}

export interface PermissionOptions {
  workspace: string;
  yolo?: boolean;
  /** Run writes and non-read-only commands without asking (the default policy). */
  autoApprove?: boolean;
  /** Hard block on writes and mutating commands, regardless of yolo or approvals. */
  readOnly?: boolean;
  handler?: ApprovalHandler;
}

export class Permissions {
  readonly workspace: string;
  #yolo: boolean;
  #autoApprove: boolean;
  #readOnly: boolean;
  #handler: ApprovalHandler | undefined;
  #alwaysCommands = new Set<string>();
  #alwaysTools = new Set<string>();
  readonly #caseInsensitive = process.platform === 'win32';

  constructor(options: PermissionOptions) {
    // Canonical form, so a workspace reached through a symlink still compares
    // correctly against real paths.
    this.workspace = realPath(resolve(options.workspace));
    this.#yolo = options.yolo ?? false;
    this.#autoApprove = options.autoApprove ?? true;
    this.#readOnly = options.readOnly ?? false;
    this.#handler = options.handler;
  }

  /**
   * Resolves a path against the workspace and canonicalises it.
   *
   * The workspace is a *default root*, not a fence: relative paths start there,
   * and an absolute path or an `../` may deliberately leave it. Symlinks are
   * still resolved, so a caller always gets the real file it will touch — but
   * that resolution no longer rejects anything for being outside.
   *
   * What remains restricted is orthogonal: `approveWrite` refuses system
   * locations, read-only mode refuses every write, and `systemRisk` blocks
   * disk/boot/registry/service operations.
   */
  resolvePath(input: string, _mode: 'read' | 'write'): string {
    if (typeof input !== 'string' || input.trim() === '') {
      throw new PermissionError('Path must be a non-empty string');
    }
    const absolute = isAbsolute(input) ? resolve(input) : resolve(this.workspace, input);
    return realPath(absolute);
  }

  isInside(target: string): boolean {
    const rel = relative(this.workspace, target);
    const inside = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
    if (!inside) return false;
    if (this.#caseInsensitive) {
      return target.toLowerCase().startsWith(this.workspace.toLowerCase());
    }
    return true;
  }

  async approveWrite(target: string): Promise<void> {
    if (this.#readOnly) throw new PermissionError(`Read-only mode: writes are disabled (${target}) — switch the header toggle to Edit to change files`);
    // A workspace opened at C:\\Windows must not become a system editor.
    if (isSystemPath(target, this.workspace)) {
      throw new PermissionError(`Refusing to change a system location: ${target}`);
    }
    if (this.#autoApprove || this.#yolo) return;
    const decision = await this.#ask({ kind: 'write', target });
    if (decision === 'deny') throw new PermissionError(`Write denied: ${target}`);
  }

  async approveCommand(command: string): Promise<void> {
    if (this.#readOnly) {
      if (isReadOnlyCommand(command)) return;
      throw new PermissionError(`Read-only mode: command blocked (${command})`);
    }
    // Disk, boot, registry, service, account, and OS-directory operations are
    // refused even though everything else is auto-approved.
    const risk = systemRisk(command, this.workspace);
    if (risk !== null) {
      throw new PermissionError(
        `Blocked system operation (${risk}) — this harness will not change the OS, disk, boot, or registry: ${command}`,
      );
    }
    if (this.#yolo || this.#autoApprove || isReadOnlyCommand(command)) return;
    const key = this.#commandKey(command);
    if (this.#alwaysCommands.has(key)) return;

    const decision = await this.#ask({ kind: 'bash', target: command });
    if (decision === 'deny') {
      throw new PermissionError(`Command denied: ${command}`);
    }
    if (decision === 'always') this.#alwaysCommands.add(key);
  }

  /** Approval for a tool whose effect cannot be classified like a shell command (MCP). */
  async approveTool(target: string): Promise<void> {
    if (this.#readOnly) {
      throw new PermissionError(`Read-only mode: tool blocked (${target})`);
    }
    if (this.#yolo || this.#autoApprove || this.#alwaysTools.has(target)) return;
    const decision = await this.#ask({ kind: 'tool', target });
    if (decision === 'deny') throw new PermissionError(`Tool denied: ${target}`);
    if (decision === 'always') this.#alwaysTools.add(target);
  }

  /** A child agent that may inspect but never mutate, whatever the parent allows. */
  asReadOnly(): Permissions {
    return new Permissions({
      workspace: this.workspace,
      yolo: false,
      autoApprove: false,
      readOnly: true,
      handler: this.#handler,
    });
  }

  #commandKey(command: string): string {
    return command.trim().split(/\s+/).slice(0, 2).join(' ');
  }

  async #ask(request: ApprovalRequest): Promise<ApprovalDecision> {
    if (!this.#handler) return 'deny';
    return this.#handler(request);
  }
}
