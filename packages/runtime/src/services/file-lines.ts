import { open } from 'fs/promises';

const CHUNK_BYTES = 64 * 1024;
const NEWLINE = 0x0a;

export interface FileLine {
  text: string;
  /** Line number counted from `start` (blank lines included). */
  index: number;
  /**
   * Byte offset just past this line's newline, where a later read can resume.
   * `null` for a last line without a newline yet: the writer may still be appending to it.
   */
  end: number | null;
}

/**
 * The lines of a file from byte `start`, read asynchronously a chunk at a time,
 * so a large file neither blocks the event loop nor sits in memory as one string.
 * Lines are split on the newline byte, which never occurs inside a UTF-8 sequence,
 * and each line is decoded whole.
 */
export async function* readFileLines(path: string, start = 0): AsyncGenerator<FileLine> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    let position = start;
    let pending: Buffer[] = [];
    let index = 0;

    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, CHUNK_BYTES, position);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);

      let lineStart = 0;
      let newline = chunk.indexOf(NEWLINE, lineStart);
      while (newline !== -1) {
        pending.push(chunk.subarray(lineStart, newline));
        yield { text: Buffer.concat(pending).toString('utf8'), index, end: position + newline + 1 };
        pending = [];
        index += 1;
        lineStart = newline + 1;
        newline = chunk.indexOf(NEWLINE, lineStart);
      }
      // The buffer is reused for the next chunk: keep a copy of the unfinished line.
      if (lineStart < bytesRead) pending.push(Buffer.from(chunk.subarray(lineStart)));
      position += bytesRead;
    }

    if (pending.length > 0) {
      yield { text: Buffer.concat(pending).toString('utf8'), index, end: null };
    }
  } finally {
    await handle.close();
  }
}
