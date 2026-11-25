import { describe, test, expect } from 'bun:test';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  resolveThreadCwd,
  canDoGitOps,
  canScheduleWakes,
  isReadOnlyThread,
  isScratchThread,
  receivesProjectSecrets,
  scratchPathFor,
} from '../../services/thread-context.js';

describe('resolveThreadCwd', () => {
  test('returns ~/.funny/scratch/<userId>/<threadId> for scratch threads', () => {
    const result = resolveThreadCwd(
      {
        id: 't-1',
        isScratch: true,
        userId: 'u-1',
        mode: 'local',
        worktreePath: undefined,
      },
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
      },
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
      },
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
      },
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
      },
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

  test('rejects userId with path traversal characters', () => {
    expect(() => scratchPathFor('../etc', 't-y')).toThrow(/userId failed shape check/);
  });

  test('rejects threadId with slashes', () => {
    expect(() => scratchPathFor('u-x', 't/y')).toThrow(/threadId failed shape check/);
  });

  test('rejects empty userId', () => {
    expect(() => scratchPathFor('', 't-y')).toThrow(/userId failed shape check/);
  });
});

describe('isScratchThread', () => {
  test('is true only for a scratch row', () => {
    expect(isScratchThread({ isScratch: true })).toBe(true);
    expect(isScratchThread({ isScratch: false })).toBe(false);
    expect(isScratchThread({ isScratch: null })).toBe(false);
    expect(isScratchThread({})).toBe(false);
  });
});

describe('isReadOnlyThread', () => {
  test('is true for a row stored read-only (the DB column is an integer)', () => {
    expect(isReadOnlyThread({ readOnly: 1 })).toBe(true);
    expect(isReadOnlyThread({ readOnly: true })).toBe(true);
    expect(isReadOnlyThread({ readOnly: 0 })).toBe(false);
    expect(isReadOnlyThread({ readOnly: null })).toBe(false);
    expect(isReadOnlyThread({})).toBe(false);
  });

  test('a read-only agent is given no project secrets', () => {
    expect(receivesProjectSecrets({ projectId: 'p1', readOnly: 0 })).toBe(true);
    expect(receivesProjectSecrets({ projectId: 'p1', readOnly: 1 })).toBe(false);
  });
});

describe('canScheduleWakes', () => {
  test('only an issue factory thread may not schedule a deferred wake', () => {
    expect(canScheduleWakes({ source: 'factory' })).toBe(false);
    expect(canScheduleWakes({ source: 'web' })).toBe(true);
    expect(canScheduleWakes({ source: 'automation' })).toBe(true);
    expect(canScheduleWakes({ source: null })).toBe(true);
    expect(canScheduleWakes(undefined)).toBe(true);
  });
});
