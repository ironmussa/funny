import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  emitToUser: vi.fn(),
  invalidateProjectStatus: vi.fn(),
}));

vi.mock('../../services/ws-broker.js', () => ({ wsBroker: { emitToUser: mocks.emitToUser } }));
vi.mock('../../services/git-runtime-service.js', () => ({
  GIT_STATUS_CACHE_TTL_MS: 2_000,
  gitStatusCache: new Map(),
  gitRuntimeService: { invalidateProjectStatus: mocks.invalidateProjectStatus },
}));
vi.mock('../../lib/telemetry.js', () => ({
  metric: vi.fn(),
  startSpan: vi.fn(() => ({ end: vi.fn() })),
}));

import { notifyStatusChanged } from '../../routes/git/helpers.js';

describe('notifyStatusChanged', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.emitToUser.mockReset();
    mocks.invalidateProjectStatus.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  test('drops the bulk status and hints the client to refetch', () => {
    notifyStatusChanged('u1', 'p1', 't1')();
    expect(mocks.emitToUser).not.toHaveBeenCalled();

    vi.advanceTimersByTime(250);
    expect(mocks.invalidateProjectStatus).toHaveBeenCalledWith('p1');
    expect(mocks.emitToUser).toHaveBeenCalledWith('u1', {
      type: 'git:refs-updated',
      threadId: 't1',
      data: { projectId: 'p1', changed: ['status'] },
    });
  });

  test('coalesces changes from one project into one project-wide hint', () => {
    notifyStatusChanged('u1', 'p1', 't1')();
    notifyStatusChanged('u1', 'p1', 't2')();
    notifyStatusChanged('u1', 'p1', 't1')();
    vi.advanceTimersByTime(250);

    expect(mocks.emitToUser).toHaveBeenCalledTimes(1);
    expect(mocks.emitToUser).toHaveBeenCalledWith('u1', {
      type: 'git:refs-updated',
      threadId: '',
      data: { projectId: 'p1', changed: ['status'] },
    });
  });

  test('keeps hints for different users and projects apart', () => {
    notifyStatusChanged('u1', 'p1')();
    notifyStatusChanged('u2', 'p1')();
    notifyStatusChanged('u1', 'p2')();
    vi.advanceTimersByTime(250);
    expect(mocks.emitToUser).toHaveBeenCalledTimes(3);
  });
});
