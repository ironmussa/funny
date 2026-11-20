/**
 * A complete `Thread` for tests that only care about a few of its fields
 * (id, owner, project). Every required field has a default; pass the fields
 * the test depends on as overrides.
 */
import type { Thread } from '@funny/shared';

export function buildThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: 'thread-1',
    projectId: 'project-1',
    userId: 'user-1',
    title: 'Test thread',
    mode: 'local',
    status: 'idle',
    stage: 'backlog',
    provider: 'claude',
    permissionMode: 'autoEdit',
    model: 'sonnet',
    cost: 0,
    source: 'web',
    runtime: 'local',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}
