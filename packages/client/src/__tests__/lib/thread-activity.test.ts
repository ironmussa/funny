import type { ThreadStatus } from '@funny/shared';
import type { FactoryRun } from '@funny/shared/contracts/factory';
import { describe, expect, test } from 'vitest';

import { threadActivity } from '@/lib/thread-activity';

const thread = (status: ThreadStatus) => ({ status });
const run = (state: FactoryRun['state']) => ({ state });

describe('threadActivity', () => {
  test('a thread without a factory run shows only its own status', () => {
    expect(threadActivity(thread('completed'), null)).toBe('none');
    expect(threadActivity(thread('completed'), undefined)).toBe('none');
  });

  test('a finished agent whose run still works (CI, PR, merge) reads as factory activity', () => {
    for (const state of ['queued', 'working', 'pr_open', 'waiting_ci', 'fixing'] as const) {
      expect(threadActivity(thread('completed'), run(state))).toBe('factory');
    }
    expect(threadActivity(thread('failed'), run('waiting_ci'))).toBe('factory');
  });

  test('a run parked for the member asks for attention', () => {
    expect(threadActivity(thread('completed'), run('waiting_human'))).toBe('factory-attention');
  });

  test('the agent own busy status wins over the run', () => {
    for (const status of ['running', 'setting_up', 'pending', 'waiting'] as const) {
      expect(threadActivity(thread(status), run('fixing'))).toBe('none');
      expect(threadActivity(thread(status), run('waiting_human'))).toBe('none');
    }
  });

  test('an ended or queued run adds nothing', () => {
    for (const state of ['merged', 'failed', 'stopped', 'requested'] as const) {
      expect(threadActivity(thread('completed'), run(state))).toBe('none');
    }
  });
});
