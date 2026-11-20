import type { Thread } from '@funny/shared';

/**
 * A `fetch` double: the handler answers every request, and `preconnect` (which
 * Bun's `fetch` type also carries) does nothing.
 */
export function fetchDouble(
  handler: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  return Object.assign(handler, { preconnect: () => {} });
}

export function buildThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: 't1',
    projectId: 'p1',
    userId: 'u1',
    title: 'Thread',
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
