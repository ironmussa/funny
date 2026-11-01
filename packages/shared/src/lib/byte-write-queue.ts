/**
 * Bounded FIFO of byte chunks waiting for a writable sink (a TCP socket that
 * accepted only part of a write). Used by both ends of the runner gRPC
 * WebSocket carrier so a slow peer can never grow memory without limit.
 */

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
