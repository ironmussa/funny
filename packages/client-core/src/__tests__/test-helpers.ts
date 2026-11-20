import { expect } from 'bun:test';

import type { Project, Thread } from '@funny/shared';

/** Asserts `value` is an instance of `type` and returns it narrowed. */
export function expectInstance<V, T>(value: V, type: abstract new (...args: never[]) => T): T {
  expect(value).toBeInstanceOf(type);
  if (!(value instanceof type)) throw new Error(`expected an instance of ${type.name}`);
  return value;
}

export function buildProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'p1',
    path: '/repo',
    userId: 'u1',
    sortOrder: 0,
    createdAt: '2026-08-23T00:00:00.000Z',
    ...overrides,
  };
}

export function buildThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: 't1',
    projectId: 'p1',
    userId: 'u1',
    title: 't1',
    mode: 'local',
    status: 'idle',
    stage: 'backlog',
    provider: 'claude',
    permissionMode: 'autoEdit',
    model: 'sonnet',
    cost: 0,
    source: 'web',
    runtime: 'local',
    createdAt: '2026-08-23T00:00:00.000Z',
    updatedAt: '2026-08-23T00:00:00.000Z',
    ...overrides,
  };
}
