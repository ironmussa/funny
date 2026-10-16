import { EventEmitter } from 'node:events';

import { describe, expect, test, vi } from 'vitest';

vi.mock('node:child_process', () => ({
  spawn: () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: () => {
        throw new Error('EPERM');
      },
    });
    return child;
  },
}));

import { createLocalRuntime } from '../adapters/local-runtime.js';

describe('runCommand timeout when the kill fails', () => {
  test('resolves with the kill failure instead of hanging on a child that never exits', async () => {
    const runtime = createLocalRuntime();
    const result = await runtime.runCommand!({
      command: 'ignored',
      cwd: process.cwd(),
      timeoutMs: 10,
    });
    expect(result).toMatchObject({
      ok: false,
      error: 'Command timed out; kill failed: EPERM',
    });
  });
});
