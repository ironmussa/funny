import { homedir } from 'node:os';
import { join } from 'node:path';

import { describe, test, expect } from 'vitest';

import { resolveThreadCwd, canDoGitOps, scratchPathFor } from '../../services/thread-context.js';

describe('resolveThreadCwd', () => {
  test('returns ~/.funny/scratch/<userId>/<threadId> for scratch threads', () => {
    const result = resolveThreadCwd(
      {
        id: 't-1',
        isScratch: true,
        userId: 'u-1',
        mode: 'local',
        worktreePath: undefined,
      } as any,
      null,
    );
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBe(join(homedir(), '.funny', 'scratch', 'u-1', 't-1'));
  });

  test('returns project.path for normal local threads', () => {
    const result = resolveThreadCwd(
      {
        id: 't-2',
        isScratch: false,
        userId: 'u-1',
        mode: 'local',
        worktreePath: undefined,
      } as any,
      { path: '/repo/foo' },
    );
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBe('/repo/foo');
  });

  test('returns worktreePath for worktree threads', () => {
    const result = resolveThreadCwd(
      {
        id: 't-3',
        isScratch: false,
        userId: 'u-1',
        mode: 'worktree',
        worktreePath: '/repo/foo-bar/t-3',
      } as any,
      { path: '/repo/foo' },
    );
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBe('/repo/foo-bar/t-3');
  });

  test('returns project-required error when a non-scratch thread has no project', () => {
    const result = resolveThreadCwd(
      {
        id: 't-4',
        isScratch: false,
        userId: 'u-1',
        mode: 'local',
        worktreePath: undefined,
      } as any,
      null,
    );
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().kind).toBe('project-required');
  });

  test('returns worktree-missing error when a worktree thread has no worktreePath', () => {
    const result = resolveThreadCwd(
      {
        id: 't-5',
        isScratch: false,
        userId: 'u-1',
        mode: 'worktree',
        worktreePath: undefined,
      } as any,
      { path: '/repo/foo' },
    );
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().kind).toBe('worktree-missing');
  });
});

describe('canDoGitOps', () => {
  test('false for scratch threads', () => {
    expect(canDoGitOps({ isScratch: true })).toBe(false);
  });

  test('true for non-scratch threads', () => {
    expect(canDoGitOps({ isScratch: false })).toBe(true);
  });
});

describe('scratchPathFor', () => {
  test('joins under ~/.funny/scratch/<userId>/<threadId>', () => {
    expect(scratchPathFor('u-x', 't-y')).toBe(join(homedir(), '.funny', 'scratch', 'u-x', 't-y'));
  });
});
