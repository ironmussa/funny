import { describe, expect, test } from 'vitest';

import { reportNativeGitStatus } from '../../app/native-git-status.js';

function recorder() {
  const calls: Array<{ level: 'info' | 'warn'; message: string; meta: Record<string, unknown> }> =
    [];
  return {
    calls,
    logger: {
      info: (message: string, meta: Record<string, unknown>) =>
        calls.push({ level: 'info', message, meta }),
      warn: (message: string, meta: Record<string, unknown>) =>
        calls.push({ level: 'warn', message, meta }),
    },
  };
}

describe('reportNativeGitStatus', () => {
  test('warns with the load error when gitoxide is unavailable', () => {
    const { calls, logger } = recorder();
    reportNativeGitStatus({ state: 'unavailable', error: 'Cannot find module' }, logger);
    expect(calls).toHaveLength(1);
    expect(calls[0].level).toBe('warn');
    expect(calls[0].meta).toMatchObject({ namespace: 'native-git', error: 'Cannot find module' });
  });

  test('logs info when gitoxide is loaded', () => {
    const { calls, logger } = recorder();
    reportNativeGitStatus({ state: 'loaded' }, logger);
    expect(calls).toEqual([
      { level: 'info', message: 'Native git (gitoxide) loaded', meta: { namespace: 'native-git' } },
    ]);
  });

  test('does not warn when explicitly disabled', () => {
    const { calls, logger } = recorder();
    reportNativeGitStatus({ state: 'disabled' }, logger);
    expect(calls.map((c) => c.level)).toEqual(['info']);
  });
});
