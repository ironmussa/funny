import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { delimiter, join } from 'path';

/**
 * Puts a fake `name` executable first on PATH that sleeps, then prints
 * `stdout`. Returns a restore function that puts PATH back and removes it.
 */
export function installSlowBinary(name: string, stdout: string, sleepSeconds = 0.4): () => void {
  const dir = join(tmpdir(), `funny-slow-bin-${Date.now()}-${Math.random()}`);
  mkdirSync(dir, { recursive: true });
  const script = join(dir, name);
  writeFileSync(script, `#!/bin/sh\nsleep ${sleepSeconds}\nprintf '%s\\n' '${stdout}'\n`);
  chmodSync(script, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${dir}${delimiter}${previousPath ?? ''}`;
  return () => {
    process.env.PATH = previousPath;
    rmSync(dir, { recursive: true, force: true });
  };
}

/**
 * Runs `work` while a 10 ms interval counts how often the event loop got a
 * turn. A call that blocks the loop (a sync spawn) leaves the count near 0.
 */
export async function countEventLoopTurns<T>(
  work: () => Promise<T>,
): Promise<{ result: T; turns: number }> {
  let turns = 0;
  const timer = setInterval(() => {
    turns += 1;
  }, 10);
  try {
    const result = await work();
    return { result, turns };
  } finally {
    clearInterval(timer);
  }
}
