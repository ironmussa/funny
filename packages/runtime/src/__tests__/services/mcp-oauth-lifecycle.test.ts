import { describe, expect, test } from 'vitest';

describe('mcp-oauth module lifecycle', () => {
  test('importing the module does not keep the process alive', async () => {
    const modulePath = new URL('../../services/mcp-oauth.ts', import.meta.url).pathname;
    const proc = Bun.spawn(
      [process.execPath, '-e', `await import(${JSON.stringify(modulePath)})`],
      {
        stdout: 'ignore',
        stderr: 'ignore',
      },
    );
    const exited = await Promise.race([
      proc.exited.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5_000)),
    ]);
    proc.kill();
    expect(exited).toBe(true);
  }, 10_000);
});
