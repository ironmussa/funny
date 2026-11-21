import { describe, expect, test, vi } from 'bun:test';

const revertOptimisticRun = (() => vi.fn())();
vi.mock('sonner', () => ({ toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }));
vi.mock('@/stores/thread-store', () => ({
  useThreadStore: { getState: () => ({ revertOptimisticRun }) },
}));

import { reportSendFailure } from '@/components/thread/use-thread-handlers';

const t = (key: string) => key;

describe('reportSendFailure', () => {
  test('undoes the running mark of the send that set it', () => {
    reportSendFailure({ type: 'INTERNAL', message: 'x' }, 't1', t);
    expect(revertOptimisticRun).toHaveBeenCalledWith('t1');
  });

  test('leaves a run alone when this send did not mark it (the thread was already running)', () => {
    revertOptimisticRun.mockClear();
    reportSendFailure({ type: 'INTERNAL', message: 'x' }, 't1', t, false);
    expect(revertOptimisticRun).not.toHaveBeenCalled();
  });
});
