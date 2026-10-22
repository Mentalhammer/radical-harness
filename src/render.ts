const COLOR = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

function paint(code: string, text: string): string {
  return COLOR ? `\x1b[${code}m${text}\x1b[0m` : text;
}

export const style = {
  dim: (text: string) => paint('2', text),
  bold: (text: string) => paint('1', text),
  cyan: (text: string) => paint('36', text),
  green: (text: string) => paint('32', text),
  yellow: (text: string) => paint('33', text),
  red: (text: string) => paint('31', text),
  magenta: (text: string) => paint('35', text),
};

export interface Ui {
  text(delta: string): void;
  endText(): void;
  toolStart(name: string, args: Record<string, unknown>): void;
  toolOutput(chunk: string): void;
  toolEnd(name: string, content: string, isError: boolean): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

const MAX_RESULT_LINES = 8;
const MAX_LINE_WIDTH = 160;

export class TerminalUi implements Ui {
  #openText = false;
  #openToolOutput = false;

  text(delta: string): void {
    if (!this.#openText) this.#openText = true;
    this.#openToolOutput = false;
    process.stdout.write(delta);
  }

  endText(): void {
    if (this.#openText) process.stdout.write('\n\n');
    this.#openText = false;
  }

  toolStart(name: string, args: Record<string, unknown>): void {
    if (this.#openText) process.stdout.write('\n');
    this.#openText = false;
    this.#openToolOutput = false;
    process.stdout.write(`${style.cyan('⏺')} ${style.bold(name)}${style.dim(`(${summarizeArgs(args)})`)}\n`);
  }

  toolOutput(chunk: string): void {
    if (this.#openText) process.stdout.write('\n');
    this.#openText = false;
    this.#openToolOutput = true;
    process.stdout.write(style.dim(chunk));
  }

  toolEnd(_name: string, content: string, isError: boolean): void {
    if (this.#openToolOutput && !content.endsWith('\n')) process.stdout.write('\n');
    this.#openToolOutput = false;

    const lines = content.split('\n');
    const shown = lines.slice(0, MAX_RESULT_LINES).map((line) => {
      const clipped = line.length > MAX_LINE_WIDTH ? `${line.slice(0, MAX_LINE_WIDTH)}…` : line;
      return `  ${clipped}`;
    });
    if (lines.length > MAX_RESULT_LINES) {
      shown.push(`  ${style.dim(`… ${lines.length - MAX_RESULT_LINES} more line(s)`)}`);
    }
    const body = shown.join('\n');
    process.stdout.write(isError ? `${style.red(body)}\n` : `${style.dim(body)}\n`);
  }

  info(message: string): void {
    process.stdout.write(`${style.dim('·')} ${message}\n`);
  }

  warn(message: string): void {
    process.stdout.write(`${style.yellow('!')} ${message}\n`);
  }

  error(message: string): void {
    process.stdout.write(`${style.red('✗')} ${message}\n`);
  }
}

function summarizeArgs(args: Record<string, unknown>): string {
  const preferred = ['path', 'command', 'pattern', 'prompt'];
  for (const key of preferred) {
    const value = args[key];
    if (typeof value === 'string' && value !== '') return clip(value);
  }
  const first = Object.values(args)[0];
  return typeof first === 'string' ? clip(first) : '';
}

function clip(value: string): string {
  const single = value.replace(/\s+/g, ' ').trim();
  return single.length > 90 ? `${single.slice(0, 90)}…` : single;
}

/**
 * JSON Lines output for scripts (`--json`). Every UI event becomes one object,
 * so a caller never has to parse ANSI or guess where a tool result ended.
 */
export class JsonUi implements Ui {
  #emit(type: string, data: Record<string, unknown> = {}): void {
    process.stdout.write(`${JSON.stringify({ type, ...data })}\n`);
  }

  text(delta: string): void {
    this.#emit('text', { text: delta });
  }

  endText(): void {
    this.#emit('text-end');
  }

  toolStart(name: string, args: Record<string, unknown>): void {
    this.#emit('tool-start', { name, args });
  }

  toolOutput(chunk: string): void {
    this.#emit('tool-output', { text: chunk });
  }

  toolEnd(name: string, content: string, isError: boolean): void {
    this.#emit('tool-end', { name, content, isError });
  }

  info(message: string): void {
    this.#emit('notice', { level: 'info', message });
  }

  warn(message: string): void {
    this.#emit('notice', { level: 'warn', message });
  }

  error(message: string): void {
    this.#emit('error', { message });
  }
}
