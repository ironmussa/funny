/**
 * Bounded FIFO of byte chunks waiting for a writable sink (a TCP socket that
 * accepted only part of a write), plus the client WebSocket surface the byte
 * pipes use. Shared by both ends of the runner gRPC WebSocket carrier and the
 * reverse runner link, so a slow peer can never grow memory without limit.
 */

/** Minimal client WebSocket surface (WHATWG / Bun `WebSocket`) of a byte pipe. */
export interface ByteWebSocket {
  binaryType: string;
  readonly bufferedAmount: number;
  readonly readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
}

/** A binary WebSocket frame as bytes; null for a text frame. */
export function frameBytes(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data))
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

export interface PartialWriter {
  /** Returns bytes accepted (may be fewer than offered), or a negative number when closed. */
  write(chunk: Uint8Array): number;
}

export class ByteWriteQueue {
  private readonly chunks: Uint8Array[] = [];
  private bytes = 0;

  constructor(private readonly maxBytes: number) {}

  get size(): number {
    return this.bytes;
  }

  /** Queues a copy of `chunk`. Returns false when the bound would be exceeded. */
  push(chunk: Uint8Array): boolean {
    if (this.bytes + chunk.byteLength > this.maxBytes) return false;
    this.chunks.push(chunk.slice());
    this.bytes += chunk.byteLength;
    return true;
  }

  /** Writes as much as the sink accepts. Returns false if the sink is closed. */
  flush(sink: PartialWriter): boolean {
    while (this.chunks.length > 0) {
      const head = this.chunks[0];
      const written = sink.write(head);
      if (written < 0) return false;
      this.bytes -= written;
      if (written < head.byteLength) {
        this.chunks[0] = head.subarray(written);
        return true;
      }
      this.chunks.shift();
    }
    return true;
  }

  clear(): void {
    this.chunks.length = 0;
    this.bytes = 0;
  }
}
