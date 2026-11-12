import { beforeEach, describe, expect, test, vi } from 'vitest';

const metric = vi.hoisted(() => vi.fn());
const info = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/telemetry.js', () => ({ metric }));
vi.mock('../../../lib/logger.js', () => ({ log: { info } }));

import { recordBashCheck } from '../../../services/checks/bash-check-metric.js';

beforeEach(() => {
  metric.mockReset();
  info.mockReset();
});

describe('recordBashCheck', () => {
  test('a check the redirect catches is counted, without a log', () => {
    recordBashCheck('t1', 'Bash', { command: 'npx vitest run src/a.test.ts 2>&1 | tail -20' });
    expect(metric).toHaveBeenCalledWith('checks.bash_check', 1, {
      attributes: { kind: 'test', tool: 'vitest', redirectable: true },
    });
    expect(info).not.toHaveBeenCalled();
  });

  test('a check that escapes it is counted and logged with its command', () => {
    const command = 'bun test $(find src -name "*.test.ts")';
    recordBashCheck('t1', 'Bash', { command });
    expect(metric).toHaveBeenCalledWith('checks.bash_check', 1, {
      attributes: { kind: 'test', tool: 'bun-test', redirectable: false },
    });
    expect(info).toHaveBeenCalledWith(
      'check run through Bash, not redirectable',
      expect.objectContaining({ threadId: 't1', command }),
    );
  });

  test('anything that is not a Bash check is ignored', () => {
    recordBashCheck('t1', 'Bash', { command: 'git status' });
    recordBashCheck('t1', 'Bash', undefined);
    recordBashCheck('t1', 'Read', { command: 'npx vitest run' });
    expect(metric).not.toHaveBeenCalled();
  });
});
