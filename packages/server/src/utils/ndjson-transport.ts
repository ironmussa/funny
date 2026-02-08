/**
 * NDJSON (Newline-Delimited JSON) transport utilities.
 * Used for communication with the claude CLI binary over stdin/stdout.
 */

/**
 * Buffers raw string chunks and splits them into complete lines.
 * Handles partial reads where a single data event may contain
 * an incomplete line or multiple lines.
 */
export class LineBuffer {
  private buffer = '';

  /**
   * Push a chunk of data and return any complete lines.
   * Incomplete trailing data is retained for the next push().
   */
  push(chunk: string): string[] {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    // Last element is either empty (if buffer ended with \n) or incomplete
    this.buffer = lines.pop() ?? '';
    return lines.filter((line) => line.trim().length > 0);
  }

  /**
   * Flush any remaining buffered data (e.g. on process exit).
   */
  flush(): string | null {
    if (this.buffer.trim().length > 0) {
      const remaining = this.buffer;
      this.buffer = '';
      return remaining;
    }
    return null;
  }
}

export function encodeNDJSON(obj: unknown): string {
  return JSON.stringify(obj) + '\n';
}

export function decodeNDJSON(line: string): unknown {
  return JSON.parse(line);
}
