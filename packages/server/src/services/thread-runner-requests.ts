/**
 * @domain subdomain: Runner Management
 * @domain subdomain-type: supporting
 * @domain type: adapter
 * @domain layer: infrastructure
 *
 * Server-initiated requests to the runner a thread runs on, signed as a user
 * the caller read from stored state (the thread owner, the factory enabler).
 * The runner is resolved from the request's own route (`withRunnerFor` with a
 * `request` target, the same rule as the proxy): a sandbox thread's own
 * sandbox runner, any other thread its project's runner — certified for that
 * user, never another user's runner.
 */

import { parseStoredJson } from '@funny/shared/json-validation';
import { err, ok, type Result } from 'neverthrow';
import { z } from 'zod';

import { authorizedRunnerRequests, runnerActor, withRunnerFor } from './runner-access/index.js';
import type { RunnerPorts } from './runner-thread-launcher.js';

export interface ThreadRunnerError {
  message: string;
  /** The thread's sandbox runner is not connected (it may be asleep). */
  sandboxAsleep: boolean;
  /** The runner received the request and answered with an error. */
  answered: boolean;
  /** The runner's answer says it recorded the failed operation as an activity. */
  activityRecorded: boolean;
}

export interface ThreadRunnerRequest {
  method: 'POST' | 'DELETE';
  path: string;
  /** Routing context: a `threadId` here sends a non-thread route to that thread's runner. */
  query?: Record<string, string>;
  body: unknown;
}

/** A runner's JSON error body (`resultToResponse`). */
const runnerErrorBody = z.object({
  error: z.string(),
  activityRecorded: z.boolean().optional(),
});

/** A runner's JSON error body: why it refused (a branch mismatch), and whether it recorded it. */
function runnerError(body: string | null | undefined): {
  text: string | null;
  activityRecorded: boolean;
} {
  if (!body) return { text: null, activityRecorded: false };
  const parsed = parseStoredJson(runnerErrorBody, body, 'runner error');
  return parsed.ok
    ? { text: parsed.value.error.slice(0, 500), activityRecorded: !!parsed.value.activityRecorded }
    : { text: null, activityRecorded: false };
}

/** Send a request to the runner a thread runs on, as `userId`. Answers the response body. */
export async function sendToThreadRunner(
  ports: RunnerPorts,
  userId: string,
  { method, path, query = {}, body }: ThreadRunnerRequest,
): Promise<Result<string | null, ThreadRunnerError>> {
  const sink = authorizedRunnerRequests(ports.requests);
  try {
    const sent = await withRunnerFor(
      runnerActor({ userId }),
      { kind: 'request', path, query },
      ports.presence,
      (actor, runner, proof) =>
        sink.send(actor, runner, proof, {
          method,
          path,
          headers: { 'Content-Type': 'application/json' },
          body: body === null ? null : JSON.stringify(body),
        }),
    );
    if (sent.isErr()) {
      const reason = sent.error.reason;
      return err({
        message: `the thread's runner is unavailable (${reason})`,
        sandboxAsleep: reason === 'thread-sandbox-unavailable',
        answered: false,
        activityRecorded: false,
      });
    }
    if (sent.value.status < 400) return ok(sent.value.body ?? null);
    const reason = runnerError(sent.value.body);
    return err({
      message: `the runner answered ${sent.value.status}${reason.text ? `: ${reason.text}` : ''}`,
      sandboxAsleep: false,
      answered: true,
      activityRecorded: reason.activityRecorded,
    });
  } catch (error) {
    return err({
      message: error instanceof Error ? error.message : String(error),
      sandboxAsleep: false,
      answered: false,
      activityRecorded: false,
    });
  }
}
