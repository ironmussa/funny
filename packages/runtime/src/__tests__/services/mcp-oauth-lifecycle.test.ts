import { describe, expect, test } from 'bun:test';

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
    // A loaded machine (a parallel suite run) can take several seconds just to
    // start the child and import the module; a handle that keeps it alive never
    // lets it exit at all, so a long wait does not weaken the check.
    const exited = await Promise.race([
      proc.exited.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 15_000)),
    ]);
    proc.kill();
    expect(exited).toBe(true);
  }, 20_000);
});
