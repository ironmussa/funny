import type { ThreadComment } from '@funny/shared';
import type { DomainError } from '@funny/shared/errors';
import { renderHook, waitFor } from '@testing-library/react';
import { errAsync, okAsync } from 'neverthrow';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { useThreadComments } from '@/data/comments/hooks';
import {
  applyCommentAdded,
  deleteComment,
  getCommentsData,
  postComment,
} from '@/data/comments/store';
import { useSchedulerQueue } from '@/data/scheduler/hooks';
import { applyRunClaimed } from '@/data/scheduler/store';

import { installTestDataLayer, resetTestDataLayer } from '../helpers/data-layer-harness';

const threadsApi = vi.hoisted(() => ({
  getThreadComments: vi.fn(),
  createThreadComment: vi.fn(),
  deleteThreadComment: vi.fn(),
}));
vi.mock('@/lib/api/threads', () => ({ threadsApi }));
const schedulerApi = vi.hoisted(() => ({ listSchedulerRuns: vi.fn(), refreshScheduler: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: schedulerApi }));
const effects = vi.hoisted(() => ({ emit: vi.fn() }));
vi.mock('@/platform/client-composition', () => ({
  clientComposition: { platform: { effects } },
}));

const comment = (id: string, createdAt: string, threadId = 't1') =>
  ({ id, threadId, userId: 'u1', source: 'user', content: id, createdAt }) as ThreadComment;
const failure: DomainError = { type: 'INTERNAL', message: 'boom' };

beforeEach(() => {
  vi.clearAllMocks();
  installTestDataLayer();
});
afterEach(() => resetTestDataLayer());

describe('comments', () => {
  test('loads on mount oldest first; events append and dedupe by id', async () => {
    threadsApi.getThreadComments.mockReturnValue(
      okAsync([comment('b', '2026-01-02'), comment('a', '2026-01-01')]),
    );
    const { result } = renderHook(() => useThreadComments('t1'));
    expect(result.current.comments).toBeNull();
    await waitFor(() => expect(result.current.comments?.map((c) => c.id)).toEqual(['a', 'b']));

    applyCommentAdded(comment('c', '2026-01-03'));
    applyCommentAdded(comment('c', '2026-01-03'));
    applyCommentAdded(comment('other', '2026-01-04', 't2'));
    await waitFor(() => expect(result.current.comments?.map((c) => c.id)).toEqual(['a', 'b', 'c']));
  });

  test('post trims and shows the comment for the author; blank is a no-op', async () => {
    threadsApi.createThreadComment.mockReturnValue(okAsync(comment('n', '2026-01-05')));
    const blank = await postComment('t1', '   ');
    expect(blank.isOk() && blank.value).toBeNull();
    expect(threadsApi.createThreadComment).not.toHaveBeenCalled();
    await postComment('t1', '  hi  ');
    expect(threadsApi.createThreadComment).toHaveBeenCalledWith('t1', 'hi');
    expect(getCommentsData().getSynced('n')).toBeDefined();
  });

  test('a refused delete puts the comment back with a toast', async () => {
    applyCommentAdded(comment('a', '2026-01-01'));
    threadsApi.deleteThreadComment.mockReturnValue(errAsync(failure));
    expect((await deleteComment('t1', 'a')).isErr()).toBe(true);
    expect(getCommentsData().read('a')).toBeDefined();
    expect(effects.emit).toHaveBeenCalledWith(expect.objectContaining({ level: 'error' }));
  });
});

describe('scheduler queue', () => {
  test('loads on mount and follows events, most recent first', async () => {
    schedulerApi.listSchedulerRuns.mockReturnValue(
      okAsync({ runs: [{ threadId: 't1', lastEventAtMs: 1 }] }),
    );
    const { result } = renderHook(() => useSchedulerQueue());
    await waitFor(() => expect(result.current.runs).toHaveLength(1));
    applyRunClaimed('t2', { userId: 'u1' });
    await waitFor(() => expect(result.current.runs.map((r) => r.threadId)).toEqual(['t2', 't1']));
  });

  test('a failed load surfaces its error', async () => {
    schedulerApi.listSchedulerRuns.mockReturnValue(errAsync(failure));
    const { result } = renderHook(() => useSchedulerQueue());
    await waitFor(() => expect(result.current.error).toBe('boom'));
  });
});
