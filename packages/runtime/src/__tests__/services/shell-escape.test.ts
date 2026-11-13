import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { executeShellEscape } from '../../services/thread-service/shell-escape.js';

const posix = process.platform !== 'win32';

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe.runIf(posix)('executeShellEscape', () => {
  const saved = { SHELL: process.env.SHELL, secret: process.env.RUNNER_AUTH_SECRET };

  beforeEach(() => {
    // `$!` and `${VAR:-x}` below are POSIX sh; the user's login shell may be fish.
    process.env.SHELL = '/bin/sh';
  });

  afterEach(() => {
    process.env.SHELL = saved.SHELL;
    if (saved.secret === undefined) delete process.env.RUNNER_AUTH_SECRET;
    else process.env.RUNNER_AUTH_SECRET = saved.secret;
  });

  test('does not pass the runner secrets to the command (#190)', async () => {
    process.env.RUNNER_AUTH_SECRET = 'runner-secret';
    const result = await executeShellEscape('echo "${RUNNER_AUTH_SECRET:-unset}"', process.cwd());
    expect(result.stdout.trim()).toBe('unset');
    expect(result.exitCode).toBe(0);
  });

  test('a timeout kills the whole process group, not just the shell (#190)', async () => {
    // The grandchild writes nowhere, so the shell's pipes close when it dies.
    const result = await executeShellEscape(
      'sleep 30 >/dev/null 2>&1 & echo $!; wait',
      process.cwd(),
      { timeoutMs: 300 },
    );
    const grandchild = Number(result.stdout.trim());
    expect(grandchild).toBeGreaterThan(0);
    expect(result.timedOut).toBe(true);

    await new Promise((r) => setTimeout(r, 200));
    const alive = isAlive(grandchild);
    if (alive) process.kill(grandchild, 'SIGKILL');
    expect(alive).toBe(false);
  });

  test('reports a non-zero exit code', async () => {
    const result = await executeShellEscape('echo out; echo err >&2; exit 3', process.cwd());
    expect(result).toMatchObject({
      stdout: 'out\n',
      stderr: 'err\n',
      exitCode: 3,
      timedOut: false,
    });
  });
});
