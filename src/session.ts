import { randomUUID } from 'node:crypto';
import { createWriteStream, mkdirSync, readFileSync, statSync } from 'node:fs';
import type { WriteStream } from 'node:fs';
import { join } from 'node:path';
import { redactValue } from './secrets.ts';
import type { Message } from './types.ts';

export interface SessionMeta {
  model: string;
  workspace: string;
  startedAt?: string;
}

export class Session {
  readonly path: string;
  readonly #stream: WriteStream;
  #closed = false;
  #broken = false;

  private constructor(path: string, stream: WriteStream) {
    this.path = path;
    this.#stream = stream;
    // A transcript is best-effort: a full disk, a deleted folder, or a path
    // that turned into a directory must never take the agent down with it.
    stream.on('error', () => {
      this.#broken = true;
      this.#closed = true;
    });
  }

  static create(directory: string, meta: SessionMeta): Session {
    mkdirSync(directory, { recursive: true });
    // The random suffix keeps two processes starting in the same millisecond
    // from writing into one log.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const path = join(directory, `${stamp}-${randomUUID().slice(0, 8)}.jsonl`);
    const session = new Session(path, createWriteStream(path, { flags: 'a' }));
    session.appendEvent({ type: 'meta', ...meta, startedAt: new Date().toISOString() });
    return session;
  }

  static open(path: string): Session {
    return new Session(path, createWriteStream(path, { flags: 'a' }));
  }

  static load(path: string): Message[] {
    // A runaway session (gigabyte transcript) must not OOM the resume path.
    const MAX_SESSION_BYTES = 20_000_000;
    try {
      const size = statSync(path).size;
      if (size > MAX_SESSION_BYTES) throw new Error('Session file is too large to resume');
    } catch (error) {
      if ((error as Error).message.includes('too large')) throw error;
    }
    const raw = readFileSync(path, 'utf8');
    const messages: Message[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (line.trim() === '') continue;
      try {
        const event = JSON.parse(line) as { type?: string; message?: Message };
        // `/clear` must survive a resume: everything before the marker is gone.
        if (event.type === 'clear') messages.length = 0;
        // A retraction drops the message a failed turn never got answered.
        else if (event.type === 'retract') messages.pop();
        else if (event.type === 'message' && event.message) messages.push(event.message);
      } catch {
        // Skip corrupt lines rather than losing the whole session.
      }
    }
    return messages;
  }

  /** Number of transcript messages, ignoring meta/clear markers (for /export summaries). */
  static count(path: string): number {
    try {
      return Session.load(path).length;
    } catch {
      return 0;
    }
  }

  /**
   * Messages and recorded working time from a single read.
   *
   * The rail needs both for every transcript whose file changed, and doing it in
   * two passes meant reading (and JSON-parsing) a multi-megabyte log twice.
   */
  static loadWithTime(path: string): { messages: Message[]; timeMs: number } {
    const MAX_SESSION_BYTES = 20_000_000;
    let raw: string;
    try {
      if (statSync(path).size > MAX_SESSION_BYTES) return { messages: [], timeMs: 0 };
      raw = readFileSync(path, 'utf8');
    } catch {
      return { messages: [], timeMs: 0 };
    }
    const messages: Message[] = [];
    let timeMs = 0;
    for (const line of raw.split(/\r?\n/)) {
      if (line.trim() === '') continue;
      try {
        const event = JSON.parse(line) as { type?: string; message?: Message; ms?: number };
        if (event.type === 'clear') messages.length = 0;
        else if (event.type === 'retract') messages.pop();
        else if (event.type === 'message' && event.message) messages.push(event.message);
        else if (event.type === 'time' && typeof event.ms === 'number' && Number.isFinite(event.ms) && event.ms > 0) {
          timeMs += Math.floor(event.ms);
        }
      } catch {
        // Skip corrupt lines instead of losing the whole transcript.
      }
    }
    return { messages, timeMs };
  }

  static timeMs(path: string): number {
    // Working time recorded for this transcript, summed from its `time` events.
    const MAX_SESSION_BYTES = 20_000_000;
    let total = 0;
    try {
      if (statSync(path).size > MAX_SESSION_BYTES) return 0;
      const raw = readFileSync(path, 'utf8');
      for (const line of raw.split(/\r?\n/)) {
        if (line.trim() === '') continue;
        try {
          const event = JSON.parse(line) as { type?: string; ms?: number };
          if (event.type !== 'time') continue;
          // Never trust a hand-edited log: only a finite, positive duration counts.
          if (typeof event.ms === 'number' && Number.isFinite(event.ms) && event.ms > 0) {
            total += Math.floor(event.ms);
          }
        } catch {
          // Skip corrupt lines instead of dropping the whole total.
        }
      }
    } catch {
      return total;
    }
    return total;
  }

  /** Records a `/clear` so resuming the log does not replay discarded turns. */
  markCleared(): void {
    this.appendEvent({ type: 'clear' });
  }

  /**
   * Withdraws the newest message. A turn that fails before the model answers
   * leaves a prompt nobody replied to, and replaying it later would put words
   * in the conversation the user never got an answer for.
   */
  retractLast(): void {
    this.appendEvent({ type: 'retract' });
  }

  append(message: Message): void {
    // The last choke point before disk: a credential that reached a transcript
    // must not be readable in .vaelen/sessions afterwards.
    this.appendEvent({ type: 'message', message: redactValue(message) });
  }

  appendEvent(event: Record<string, unknown>): void {
    // A turn can outlive its session (workspace switch, deleted chat, shutdown).
    if (this.#closed || this.#broken) return;
    try {
      this.#stream.write(`${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
    } catch {
      this.#broken = true;
    }
  }

  close(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    this.#closed = true;
    return new Promise((resolve) => {
      this.#stream.end(() => resolve());
    });
  }
}
