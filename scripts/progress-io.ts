// Output handling shared by the runners that report live progress
// (`run-tests.ts`, `run-steps.ts`): printing a child's output as it comes or
// buffered under a title. The progress file itself is written by
// `ThrottledJsonFile` in `@funny/shared/checks/progress-file`.

import { pumpLines } from '../packages/shared/src/checks/progress-file';

/** Output of a finished child process. */
export interface CollectedOutput {
  code: number;
  durationMs: number;
}

/**
 * Waits for `proc` and prints its output: as it comes, or (`buffered`) all at
 * once under `title` when it ends, followed by a ✓/✗ line with the time since
 * `start`. Every line also goes to `onLine`; lines `hide` matches go only there.
 */
export async function collectOutput(
  proc: {
    exited: Promise<number>;
    stdout: ReadableStream<Uint8Array>;
    stderr: ReadableStream<Uint8Array>;
  },
  {
    title,
    buffered,
    start,
    onLine,
    hide,
  }: {
    title: string;
    buffered: boolean;
    start: number;
    onLine?: (line: string) => void;
    hide?: (line: string) => boolean;
  },
): Promise<CollectedOutput> {
  let output = '';
  const sink = (target: NodeJS.WriteStream) => (line: string) => {
    onLine?.(line);
    if (hide?.(line)) return;
    if (buffered) output += `${line}\n`;
    else target.write(`${line}\n`);
  };
  const [code] = await Promise.all([
    proc.exited,
    pumpLines(proc.stdout, sink(process.stdout)),
    pumpLines(proc.stderr, sink(process.stderr)),
  ]);
  const durationMs = performance.now() - start;
  if (buffered) {
    console.log(`\n=== ${title} ===\n${output}`);
    console.log(`${code === 0 ? '✓' : '✗'} ${title} ${(durationMs / 1000).toFixed(1)}s`);
  }
  return { code, durationMs };
}
