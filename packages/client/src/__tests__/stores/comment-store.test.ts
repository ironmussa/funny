import type { ThreadComment } from '@funny/shared';
import { okAsync } from 'neverthrow';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { useCommentStore } from '@/stores/comment-store';

vi.mock('@/lib/api/threads', () => ({
  threadsApi: {
    getThreadComments: vi.fn(),
    createThreadComment: vi.fn(),
    deleteThreadComment: vi.fn(),
  },
}));

import { threadsApi } from '@/lib/api/threads';

function comment(over: Partial<ThreadComment> = {}): ThreadComment {
  return {
    id: 'c1',
    threadId: 't1',
    userId: 'u1',
    source: 'user',
    content: 'hello',
    createdAt: '2026-01-01T00:00:00.000Z',
    user: { id: 'u1', name: 'Ana', image: null, username: 'ana' },
    ...over,
  };
}

describe('useCommentStore', () => {
  beforeEach(() => {
    useCommentStore.setState({ byThread: {}, loadingByThread: {} });
    vi.clearAllMocks();
  });
  afterEach(() => vi.restoreAllMocks());

  test('fetch populates the thread bucket', async () => {
    (threadsApi.getThreadComments as any).mockReturnValue(okAsync([comment()]));
    await useCommentStore.getState().fetch('t1');
    expect(useCommentStore.getState().byThread['t1']).toHaveLength(1);
    expect(useCommentStore.getState().loadingByThread['t1']).toBe(false);
  });

  test('applyAdded appends and dedupes by id, keeping chronological order', () => {
    const s = useCommentStore.getState();
    s.applyAdded('t1', comment({ id: 'c2', createdAt: '2026-01-01T00:00:02.000Z' }));
    s.applyAdded('t1', comment({ id: 'c1', createdAt: '2026-01-01T00:00:01.000Z' }));
    // Duplicate id is ignored.
    s.applyAdded('t1', comment({ id: 'c1', createdAt: '2026-01-01T00:00:09.000Z' }));

    const list = useCommentStore.getState().byThread['t1'];
    expect(list.map((c) => c.id)).toEqual(['c1', 'c2']);
  });

  test('applyDeleted removes the comment', () => {
    useCommentStore.setState({ byThread: { t1: [comment({ id: 'c1' }), comment({ id: 'c2' })] } });
    useCommentStore.getState().applyDeleted('t1', 'c1');
    expect(useCommentStore.getState().byThread['t1'].map((c) => c.id)).toEqual(['c2']);
  });

  test('post trims, calls the API, and reconciles the returned comment', async () => {
    const created = comment({ id: 'c9', content: 'posted' });
    (threadsApi.createThreadComment as any).mockReturnValue(okAsync(created));

    const ok = await useCommentStore.getState().post('t1', '  posted  ');
    expect(ok).toBe(true);
    expect(threadsApi.createThreadComment).toHaveBeenCalledWith('t1', 'posted');
    expect(useCommentStore.getState().byThread['t1'].map((c) => c.id)).toContain('c9');
  });

  test('post is a no-op for blank content', async () => {
    const ok = await useCommentStore.getState().post('t1', '   ');
    expect(ok).toBe(false);
    expect(threadsApi.createThreadComment).not.toHaveBeenCalled();
  });

  test('remove deletes via the API and drops it locally', async () => {
    useCommentStore.setState({ byThread: { t1: [comment({ id: 'c1' })] } });
    (threadsApi.deleteThreadComment as any).mockReturnValue(okAsync(undefined));

    await useCommentStore.getState().remove('t1', 'c1');
    expect(threadsApi.deleteThreadComment).toHaveBeenCalledWith('t1', 'c1');
    expect(useCommentStore.getState().byThread['t1']).toHaveLength(0);
  });
});
