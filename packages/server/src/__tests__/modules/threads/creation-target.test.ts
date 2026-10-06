/**
 * Pure normalization tests. This file imports only the domain module, so no DB,
 * Hono app, or runner is loaded.
 */
import { describe, expect, test } from 'bun:test';

import { normalizeCreationRequest } from '../../../modules/threads/domain/creation-target.js';
import {
  authenticatedUserId,
  createdThreadId,
  resolvedRunnerId,
  type RunnerId,
  type ThreadId,
  type UserId,
} from '../../../modules/threads/domain/ids.js';

describe('normalizeCreationRequest', () => {
  test('project request keeps the payload object untouched', () => {
    const raw = { projectId: 'p1', mode: 'worktree', extra: { a: 1 } };
    const result = normalizeCreationRequest(raw);
    expect(result._unsafeUnwrap().target).toEqual({ kind: 'project', projectId: 'p1' });
    expect(result._unsafeUnwrap().payload).toBe(raw);
  });

  test('scratch request normalizes projectId/mode and keeps extensions', () => {
    const result = normalizeCreationRequest({ isScratch: true, title: 'x', extra: 1 });
    const value = result._unsafeUnwrap();
    expect(value.target).toEqual({ kind: 'scratch', mode: 'local' });
    expect(value.payload).toEqual({
      isScratch: true,
      title: 'x',
      extra: 1,
      projectId: null,
      mode: 'local',
    });
  });

  test('normalized output is immutable', () => {
    const value = normalizeCreationRequest({ isScratch: true })._unsafeUnwrap();
    expect(Object.isFrozen(value.target)).toBe(true);
    expect(Object.isFrozen(value.payload)).toBe(true);
    const project = normalizeCreationRequest({ projectId: 'p1' })._unsafeUnwrap();
    expect(Object.isFrozen(project.target)).toBe(true);
  });

  test('scratch with a project fails before the mode conflict', () => {
    const error = normalizeCreationRequest({
      isScratch: true,
      projectId: 'p1',
      mode: 'worktree',
    })._unsafeUnwrapErr();
    expect(error.code).toBe('scratch-thread-cannot-have-project');
  });

  test('scratch with non-local mode is rejected; falsy mode is accepted', () => {
    expect(
      normalizeCreationRequest({ isScratch: true, mode: 'worktree' })._unsafeUnwrapErr().code,
    ).toBe('scratch-thread-must-be-local');
    expect(normalizeCreationRequest({ isScratch: true, mode: '' }).isOk()).toBe(true);
    expect(normalizeCreationRequest({ isScratch: true, projectId: undefined }).isOk()).toBe(true);
  });

  test('missing/empty project on a non-scratch request is rejected', () => {
    for (const raw of [{}, { projectId: '' }, { projectId: null }, { isScratch: 'true' }]) {
      expect(normalizeCreationRequest(raw)._unsafeUnwrapErr()).toEqual({
        code: 'project-required',
        message: 'projectId is required',
      });
    }
  });
});

describe('branded identifiers', () => {
  test('brands are erased at runtime', () => {
    expect(authenticatedUserId('u') as string).toBe('u');
    expect(resolvedRunnerId('r') as string).toBe('r');
    expect(createdThreadId('t') as string).toBe('t');
  });

  test('identifiers are not interchangeable (checked by `bun run typecheck`)', () => {
    const takesRunner = (id: RunnerId) => id;
    const takesThread = (id: ThreadId) => id;
    const takesUser = (id: UserId) => id;
    const user = authenticatedUserId('u');
    const runner = resolvedRunnerId('r');

    // @ts-expect-error — a UserId is not a RunnerId
    takesRunner(user);
    // @ts-expect-error — a RunnerId is not a ThreadId
    takesThread(runner);
    // @ts-expect-error — a plain string is not a UserId
    takesUser('raw');

    expect(takesUser(user) as string).toBe('u');
  });
});
