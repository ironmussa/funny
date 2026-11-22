/**
 * @domain subdomain: Process Management
 * @domain subdomain-type: supporting
 * @domain type: adapter
 * @domain layer: infrastructure
 *
 * NDJSON framing for the PTY daemon's Unix socket, shared by the daemon
 * (`pty-daemon.ts`) and its client (`pty-backend-daemon.ts`).
 *
 * - Reading: a socket chunk can end in the middle of a line or of a multibyte
 *   UTF-8 character. `NdjsonLineDecoder` decodes with a streaming
 *   `TextDecoder` (which holds back an incomplete character until the rest
 *   arrives) and only yields complete lines.
 * - Writing: Bun's `socket.write()` may accept fewer bytes than given when the
 *   socket is backpressured, and the rest is dropped. `SocketWriteQueue` keeps
 *   the unwritten bytes and sends them, in order, from the socket's `drain`
 *   handler.
 *
 * This file is copied next to `pty-daemon.ts` in `dist/` (see `build.ts`), so
 * it must stay standalone: no imports.
 */

/** Splits a byte stream into complete NDJSON lines, decoding UTF-8 across chunks. */
export class NdjsonLineDecoder {
  private readonly decoder = new TextDecoder();
  private buffer = '';

  /** Feeds a chunk and returns the complete, non-empty lines it finished. */
  push(chunk: Uint8Array): string[] {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    const lines: string[] = [];
    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIdx).trim();
      this.buffer = this.buffer.slice(newlineIdx + 1);
      if (line.length > 0) lines.push(line);
    }
    return lines;
  }
}

/** The part of a Bun socket the write queue uses. */
export interface WritableSocket {
  /** Returns the number of bytes accepted (may be fewer than given, or negative when closed). */
  write(data: Uint8Array): number;
}

/** Default cap on bytes waiting for a slow peer (32 MiB). */
const DEFAULT_MAX_PENDING_BYTES = 32 * 1024 * 1024;

/** Writes whole lines to a socket, keeping what a backpressured write did not accept. */
export class SocketWriteQueue {
  private static readonly encoder = new TextEncoder();
  private readonly pending: Uint8Array[] = [];
  private pendingByteCount = 0;

  constructor(
    private readonly socket: WritableSocket,
    private readonly maxPendingBytes = DEFAULT_MAX_PENDING_BYTES,
  ) {}

  /** Bytes accepted by `write()` but not yet taken by the socket. */
  get pendingBytes(): number {
    return this.pendingByteCount;
  }

  /**
   * Queues `text` after anything still pending and writes as much as the
   * socket takes. Returns false (and queues nothing) when the pending bytes
   * would exceed the cap: the peer is not reading, and the caller should drop
   * the connection rather than grow memory without bound.
   */
  write(text: string): boolean {
    const bytes = SocketWriteQueue.encoder.encode(text);
    if (bytes.byteLength === 0) return true;
    if (this.pendingByteCount + bytes.byteLength > this.maxPendingBytes) return false;
    this.pending.push(bytes);
    this.pendingByteCount += bytes.byteLength;
    this.flush();
    return true;
  }

  /** Call from the socket's `drain` handler. */
  drain(): void {
    this.flush();
  }

  private flush(): void {
    while (this.pending.length > 0) {
      const head = this.pending[0];
      const written = Math.max(0, this.socket.write(head));
      this.pendingByteCount -= written;
      if (written < head.byteLength) {
        // Backpressured: keep the rest and wait for `drain`.
        this.pending[0] = head.subarray(written);
        return;
      }
      this.pending.shift();
    }
  }
}
