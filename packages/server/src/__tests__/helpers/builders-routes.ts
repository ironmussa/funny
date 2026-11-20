/** Typed fixtures for the route tests (`__tests__/routes/**`). */
import type { Thread } from '@funny/shared';
import type { RunnerInfo } from '@funny/shared/runner-protocol';
import { z } from 'zod';

import type * as runnerManager from '../../services/runner-manager.js';
import type { RunnerRequest, RunnerRequestPort } from '../../services/runner-ports.js';

// ── Response bodies ─────────────────────────────────────────

/**
 * Parse a response body with `schema`. Use loose objects (`z.looseObject`) so
 * unknown fields survive and assertions about absent fields stay meaningful.
 */
export async function readJson<S extends z.ZodType>(
  res: Response,
  schema: S,
): Promise<z.output<S>> {
  return schema.parse(await res.json());
}

/** Rows that carry an `id`, such as `GET /api/users/search`. */
export const idRowsSchema = z.array(z.looseObject({ id: z.string() }));

// ── Runners ─────────────────────────────────────────────────

/** A connected runner as `runner-manager` reports it. */
function buildRunnerInfo(overrides: Partial<RunnerInfo> = {}): RunnerInfo {
  const now = new Date().toISOString();
  return {
    runnerId: 'runner-1',
    name: 'Test Runner',
    hostname: 'test-host',
    os: 'linux',
    status: 'online',
    activeThreadCount: 0,
    assignedProjectIds: [],
    registeredAt: now,
    lastHeartbeatAt: now,
    ...overrides,
  };
}

/** What `runner-manager.findRunnerForProject` answers when a runner matches. */
export type ProjectRunnerMatch = NonNullable<
  Awaited<ReturnType<typeof runnerManager.findRunnerForProject>>
>;

/** A `findRunnerForProject` match on `runnerId`. */
export function buildProjectRunnerMatch(
  runnerId: string,
  localPath = '/tmp/test-repo',
): ProjectRunnerMatch {
  return { runner: buildRunnerInfo({ runnerId }), localPath };
}

/** The JSON body a runner request carried (runner requests send strings), parsed with `schema`. */
export function runnerRequestJson<S extends z.ZodType>(
  request: RunnerRequest,
  schema: S,
): z.output<S> {
  return schema.parse(JSON.parse(z.string().parse(request.body)));
}

// ── fetch ───────────────────────────────────────────────────

/** A `fetch` double: `handler` gets the request URL as a string and the init. */
export function fakeFetch(
  handler: (url: string, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  const impl = async (input: string | URL | Request, init?: RequestInit) =>
    handler(input instanceof Request ? input.url : input.toString(), init);
  return Object.assign(impl, { preconnect: fetch.preconnect });
}

// ── Threads ─────────────────────────────────────────────────

/** A thread as `requireThread*` puts it on the context (`c.get('thread')`). */
export function buildThread(overrides: Partial<Thread> = {}): Thread {
  const now = new Date().toISOString();
  return {
    id: 'test-thread-1',
    projectId: 'test-project-1',
    userId: 'user-1',
    title: 'Test Thread',
    mode: 'local',
    status: 'pending',
    stage: 'backlog',
    provider: 'claude',
    permissionMode: 'autoEdit',
    model: 'sonnet',
    cost: 0,
    source: 'web',
    runtime: 'local',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** A runner transport for suites whose code under test must never reach a runner. */
export function unreachableRunnerRequests(): RunnerRequestPort {
  return {
    isAvailable: async () => false,
    request: async (runnerId) => {
      throw new Error(`unexpected request to runner ${runnerId}`);
    },
  };
}
