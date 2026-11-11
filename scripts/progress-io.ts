// I/O shared by the runners that report live progress (`run-tests.ts`,
// `run-steps.ts`): reading a child's output line by line, and rewriting a
// JSON progress file atomically, at most every `intervalMs`.

import { renameSync, writeFileSync } from 'node:fs';

/** Reads a child's stream, handing each line to `onLine`; resolves when it ends. */
export async function pumpLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  let partial = '';
  for await (const bytes of stream) {
    const lines = (partial + decoder.decode(bytes, { stream: true })).split('\n');
    partial = lines.pop()!;
    lines.forEach(onLine);
  }
  if (partial) onLine(partial);
}

export interface ThrottleOptions {
  intervalMs?: number;
  now?: () => number;
}

/**
 * A JSON file rewritten as `value` changes: `changed()` schedules a write at
 * most every `intervalMs`, `flush()` writes now. `stamp` runs before each write
 * (e.g. to set `updatedAt`). Each write goes to a temp file then is renamed, so
 * a reader never sees half of it.
 */
export class ThrottledJsonFile<T> {
  private lastWrite = 0;
  private pending: ReturnType<typeof setTimeout> | null = null;
  private readonly intervalMs: number;
  readonly now: () => number;

  constructor(
    private readonly path: string,
    readonly value: T,
    private readonly stamp: (value: T, now: number) => void,
    { intervalMs = 500, now = Date.now }: ThrottleOptions = {},
  ) {
    this.intervalMs = intervalMs;
    this.now = now;
  }

  changed(): void {
    if (this.pending) return;
    const wait = this.lastWrite + this.intervalMs - this.now();
    if (wait <= 0) this.flush();
    else this.pending = setTimeout(() => this.flush(), wait);
  }

  flush(): void {
    if (this.pending) clearTimeout(this.pending);
    this.pending = null;
    this.lastWrite = this.now();
    this.stamp(this.value, this.lastWrite);
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.value));
    renameSync(tmp, this.path);
  }
}
