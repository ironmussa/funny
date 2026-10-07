/**
 * The one path that creates a thread on a user's runner, for server-initiated
 * work (automations). It delegates to the `modules/threads` creation use case,
 * the same code `POST /api/threads` runs, so runner isolation, the
 * project ↔ runner binding, identity signing, and registration are enforced
 * in one place.
 *
 * @domain subdomain: Runner Orchestration
 * @domain type: app-service
 * @domain layer: application
 */

import { err, ok, type Result } from 'neverthrow';

import { log } from '../lib/logger.js';
import { composeCreateThread, runnerPathFor } from '../modules/threads/composition.js';
import { authenticatedUserId, type CreationIntent } from '../modules/threads/index.js';
import type { RunnerPresencePort, RunnerRequestPort } from './runner-ports.js';
import { describeResolutionFailure } from './runner-resolver.js';

export interface RunnerPorts {
  requests: RunnerRequestPort;
  presence?: RunnerPresencePort;
}

export interface StartThreadInput {
  /** The user the thread belongs to and whose runner it must run on. */
  userId: string;
  orgId?: string;
  role?: string;
  orgName?: string;
  /**
   * Request body for the runner's thread-creation endpoint. The project (or
   * `isScratch: true`) is read from here, as for `POST /api/threads`.
   */
  body: Record<string, unknown>;
  /** `idle` creates without starting. Defaults to `normal` (create + start). */
  intent?: CreationIntent;
}

export type StartThreadError =
  | { kind: 'runner-unavailable'; status: 502; message: string }
  | { kind: 'runner-error'; status: number; message: string };

export interface StartedThread {
  /** The runner's response body (the created thread). */
  thread: any;
  threadId: string | undefined;
  runnerId: string;
}

/**
 * Create (and, for the `normal` intent, start) a thread on `userId`'s runner
 * and register it on the server. Never falls back to another user's runner.
 */
export async function startThreadOnRunner(
  input: StartThreadInput,
  ports: RunnerPorts,
): Promise<Result<StartedThread, StartThreadError>> {
  const intent = input.intent ?? 'normal';
  const createThread = composeCreateThread({
    runnerRequests: ports.requests,
    runnerPresence: ports.presence,
  });
  const result = await createThread({
    actor: {
      userId: authenticatedUserId(input.userId),
      organizationId: input.orgId,
      role: input.role,
      organizationName: input.orgName,
    },
    intent,
    payload: input.body,
  });
  if (result.isOk()) {
    const { thread, threadId, runnerId } = result.value;
    return ok({ thread, threadId, runnerId });
  }

  const failure = result.error;
  switch (failure.kind) {
    case 'rejected':
      return err({ kind: 'runner-error', status: 400, message: failure.message });
    case 'no-runner':
      return err({
        kind: 'runner-unavailable',
        status: 502,
        message: describeResolutionFailure(failure.reason).error,
      });
    case 'remote-error':
      return err({ kind: 'runner-error', status: failure.status, message: failure.message });
    case 'creation-failed': {
      const cause = failure.cause as Error;
      log.error('Failed to create thread on runner', {
        namespace: 'threads',
        error: cause?.message ?? String(cause),
        stack: cause?.stack,
        path: runnerPathFor(intent),
      });
      return err({ kind: 'runner-error', status: 502, message: 'Thread creation failed' });
    }
  }
}
