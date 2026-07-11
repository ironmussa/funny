import type { Thread } from '@funny/shared';
import { describe, test, expect } from 'vitest';

import {
  canConvertToWorktree,
  canDoGitOps,
  canFetchGitStatus,
  canLoadGitHistory,
  canForkAndRewindCode,
  canRewindCode,
  canShowPowerline,
  canCommentShare,
  canSteerShare,
  canViewGitShare,
  getSidebarBucket,
  getThreadRoute,
  isScratch,
  supportsCodeRewind,
} from '@/lib/thread-variant';

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: 't-1',
    projectId: 'p-1',
    title: 'Test',
    status: 'idle' as Thread['status'],
    cost: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as Thread;
}

describe('isScratch', () => {
  test('returns false for normal threads', () => {
    expect(isScratch(makeThread({ isScratch: false }))).toBe(false);
    expect(isScratch(makeThread())).toBe(false);
  });

  test('returns true when isScratch is set', () => {
    expect(isScratch(makeThread({ isScratch: true }))).toBe(true);
  });

  test('returns false for null/undefined', () => {
    expect(isScratch(null)).toBe(false);
    expect(isScratch(undefined)).toBe(false);
  });
});

describe('canDoGitOps / canShowPowerline / canFetchGitStatus', () => {
  test('allow git for normal threads', () => {
    const thread = makeThread({ isScratch: false });
    expect(canDoGitOps(thread)).toBe(true);
    expect(canShowPowerline(thread)).toBe(true);
    expect(canFetchGitStatus(thread)).toBe(true);
  });

  test('block git for scratch threads', () => {
    const thread = makeThread({ isScratch: true });
    expect(canDoGitOps(thread)).toBe(false);
    expect(canShowPowerline(thread)).toBe(false);
    expect(canFetchGitStatus(thread)).toBe(false);
  });

  test('block git when thread is missing', () => {
    expect(canDoGitOps(null)).toBe(false);
    expect(canShowPowerline(undefined)).toBe(false);
    expect(canFetchGitStatus(null)).toBe(false);
  });
});

describe('canLoadGitHistory', () => {
  test('allows git history for normal threads with a project', () => {
    expect(canLoadGitHistory(makeThread({ projectId: 'p-1', isScratch: false }))).toBe(true);
  });

  test('blocks git history for scratch or projectless threads', () => {
    expect(canLoadGitHistory(makeThread({ projectId: '', isScratch: true }))).toBe(false);
    expect(canLoadGitHistory(makeThread({ projectId: '', isScratch: false }))).toBe(false);
  });

  test('blocks git history when thread is missing', () => {
    expect(canLoadGitHistory(null)).toBe(false);
    expect(canLoadGitHistory(undefined)).toBe(false);
  });
});

describe('Codex rewind capabilities', () => {
  test('allows a checkpointed Codex thread to rewind but not fork and rewind', () => {
    const thread = makeThread({ provider: 'codex', fileCheckpointingEnabled: true });

    expect(supportsCodeRewind(thread)).toBe(true);
    expect(canRewindCode(thread)).toBe(true);
    expect(canForkAndRewindCode(thread)).toBe(false);
  });

  test('requires a checkpoint and keeps Claude fork-and-rewind support', () => {
    expect(canRewindCode(makeThread({ provider: 'codex', fileCheckpointingEnabled: false }))).toBe(
      false,
    );
    expect(canForkAndRewindCode(makeThread({ provider: 'claude' }))).toBe(true);
  });

  test('does not support rewind for other providers', () => {
    const thread = makeThread({ provider: 'gemini', fileCheckpointingEnabled: true });

    expect(supportsCodeRewind(thread)).toBe(false);
    expect(canRewindCode(thread)).toBe(false);
    expect(canForkAndRewindCode(thread)).toBe(false);
  });
});

describe('canConvertToWorktree', () => {
  test('allows local non-scratch threads', () => {
    expect(canConvertToWorktree(makeThread({ mode: 'local', isScratch: false }))).toBe(true);
  });

  test('blocks scratch threads', () => {
    expect(canConvertToWorktree(makeThread({ mode: 'local', isScratch: true }))).toBe(false);
  });

  test('blocks threads already in worktree mode', () => {
    expect(canConvertToWorktree(makeThread({ mode: 'worktree', isScratch: false }))).toBe(false);
  });

  test('returns false for null/undefined', () => {
    expect(canConvertToWorktree(null)).toBe(false);
    expect(canConvertToWorktree(undefined)).toBe(false);
  });
});

describe('getThreadRoute', () => {
  test('routes scratch threads under /scratch/:id', () => {
    expect(getThreadRoute(makeThread({ id: 'abc', isScratch: true }))).toBe('/scratch/abc');
  });

  test('routes project threads under /projects/:pid/threads/:id', () => {
    expect(getThreadRoute(makeThread({ id: 't-2', projectId: 'proj-9', isScratch: false }))).toBe(
      '/projects/proj-9/threads/t-2',
    );
  });
});

describe('canSteerShare / canViewGitShare (thread-sharing-steer)', () => {
  const OWNER = 'owner-1';
  const SHAREE = 'ana-2';

  test('owner can always steer + view git, regardless of level field', () => {
    const t = makeThread({ userId: OWNER });
    expect(canSteerShare(t, OWNER)).toBe(true);
    expect(canViewGitShare(t, OWNER)).toBe(true);
  });

  test('a steer sharee can steer + view git', () => {
    const t = makeThread({ userId: OWNER, viewerShareLevel: 'steer' });
    expect(canSteerShare(t, SHAREE)).toBe(true);
    expect(canViewGitShare(t, SHAREE)).toBe(true);
  });

  test('a view sharee can NOT steer or view git', () => {
    const t = makeThread({ userId: OWNER, viewerShareLevel: 'view' });
    expect(canSteerShare(t, SHAREE)).toBe(false);
    expect(canViewGitShare(t, SHAREE)).toBe(false);
  });

  test('a sharee with no loaded level (list-only thread) can NOT steer', () => {
    const t = makeThread({ userId: OWNER });
    expect(canSteerShare(t, SHAREE)).toBe(false);
  });

  test('returns false for null thread or missing user', () => {
    expect(canSteerShare(null, SHAREE)).toBe(false);
    expect(canSteerShare(makeThread({ userId: OWNER, viewerShareLevel: 'steer' }), null)).toBe(
      false,
    );
  });
});

describe('canCommentShare (viewer < commenter < editor)', () => {
  const OWNER = 'owner-1';
  const SHAREE = 'ana-2';

  test('owner can always comment', () => {
    expect(canCommentShare(makeThread({ userId: OWNER }), OWNER)).toBe(true);
  });

  test('commenter and editor (steer) sharees can comment', () => {
    expect(
      canCommentShare(makeThread({ userId: OWNER, viewerShareLevel: 'comment' }), SHAREE),
    ).toBe(true);
    expect(canCommentShare(makeThread({ userId: OWNER, viewerShareLevel: 'steer' }), SHAREE)).toBe(
      true,
    );
  });

  test('a view-only sharee can NOT comment', () => {
    expect(canCommentShare(makeThread({ userId: OWNER, viewerShareLevel: 'view' }), SHAREE)).toBe(
      false,
    );
    // No loaded level (list-only) → also false.
    expect(canCommentShare(makeThread({ userId: OWNER }), SHAREE)).toBe(false);
  });
});

describe('getSidebarBucket', () => {
  test('returns scratch bucket for scratch threads', () => {
    expect(getSidebarBucket(makeThread({ isScratch: true }))).toBe('scratch');
  });

  test('returns project bucket for normal threads', () => {
    expect(getSidebarBucket(makeThread({ isScratch: false }))).toBe('project');
  });

  test('defaults to project for null/undefined', () => {
    expect(getSidebarBucket(null)).toBe('project');
    expect(getSidebarBucket(undefined)).toBe('project');
  });
});
