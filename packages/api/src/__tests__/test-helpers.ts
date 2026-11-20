import type { Automation, Thread } from '@funny/shared';

import type { ApiPorts } from '../ports.js';

/** The JSON body of a tRPC fetch-adapter response: a result or an error. */
export interface TrpcResponseBody {
  result?: { data: unknown };
  error?: {
    message: string;
    friendlyMessage?: string;
    data: { code: string; stack?: string };
  };
}

export async function readTrpcBody(res: Response): Promise<TrpcResponseBody> {
  const body: TrpcResponseBody = await res.json();
  return body;
}

export function buildAutomation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: 'a1',
    projectId: 'p1',
    userId: 'u1',
    name: 'Job',
    prompt: 'p',
    schedule: '0 * * * *',
    provider: 'claude',
    model: 'sonnet',
    mode: 'local',
    permissionMode: 'autoEdit',
    enabled: true,
    maxRunHistory: 20,
    source: 'ui',
    createdAt: 'now',
    updatedAt: 'now',
    ...overrides,
  };
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
    createdAt: 'now',
    updatedAt: 'now',
    ...overrides,
  };
}

/**
 * Ports for a test that only reaches the ports it passes. `ApiPorts` has a
 * dozen ports with many methods each; a procedure test exercises one.
 */
export function portsWith(stubbed: Partial<ApiPorts>): ApiPorts {
  // SAFETY: callers stub every port the procedures under test read; a stray read of another port would surface as a TypeError in the test.
  return stubbed as ApiPorts;
}
