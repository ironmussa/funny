/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: infrastructure-adapter
 * @domain layer: infrastructure
 *
 * Start, poll and stop a job on the runner of a run's thread (a regression
 * proof, a factory step), as the thread's owner: every request goes through the
 * certified runner sink (`withRunnerFor`), never to another user's runner.
 */

import { parseStoredJson } from '@funny/shared/json-validation';
import { err, ok, type Result } from 'neverthrow';
import { z } from 'zod';

import { log } from '../../lib/logger.js';
import { authorizedRunnerRequests, runnerActor, withRunnerFor } from '../runner-access/index.js';
import type { RunnerPorts } from '../runner-thread-launcher.js';

/** The prefix of an error that means the runner could not be reached (the wait may ride it out). */
export const RUNNER_UNAVAILABLE_PREFIX = 'runner unavailable: ';

const runnerErrorBody = z.object({ error: z.string() }).passthrough();

/** The runner's `{ error }` message, when its answer carries one. */
export function runnerErrorText(body: string | null | undefined): string | null {
  if (!body) return null;
  const parsed = parseStoredJson(runnerErrorBody, body, 'runner error');
  return parsed.ok ? parsed.value.error.slice(0, 500) : null;
}

/** One request to the thread's runner: its status and body, or why it could not be sent. */
async function send(
  ports: RunnerPorts,
  userId: string,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body: Record<string, unknown> | null,
): Promise<Result<{ status: number; body: string | null }, string>> {
  const sink = authorizedRunnerRequests(ports.requests);
  try {
    const sent = await withRunnerFor(
      runnerActor({ userId }),
      { kind: 'request', path, query: {} },
      ports.presence,
      (actor, runner, proof) =>
        sink.send(actor, runner, proof, {
          method,
          path,
          headers: body ? { 'Content-Type': 'application/json' } : {},
          body: body ? JSON.stringify(body) : null,
        }),
    );
    if (sent.isErr()) return err(`${RUNNER_UNAVAILABLE_PREFIX}${sent.error.reason}`);
    return ok({ status: sent.value.status, body: sent.value.body ?? null });
  } catch (error) {
    return err(error instanceof Error ? error.message : String(error));
  }
}

/** The runner's answer parsed with `schema`, or why not (its status and message). */
function answer<T>(
  sent: { status: number; body: string | null },
  schema: z.ZodType<T>,
  label: string,
): Result<T, string> {
  if (sent.status >= 400) {
    const reason = runnerErrorText(sent.body);
    return err(`runner answered ${sent.status}${reason ? `: ${reason}` : ''}`);
  }
  const parsed = parseStoredJson(schema, sent.body ?? '{}', label);
  return parsed.ok ? ok(parsed.value) : err(`invalid ${label}`);
}

/** Start a job at `path` (POST); the runner's answer as `schema` says. */
export async function startRunnerJob<T>(
  ports: RunnerPorts,
  userId: string,
  path: string,
  body: Record<string, unknown>,
  schema: z.ZodType<T>,
  label: string,
): Promise<Result<T, string>> {
  const sent = await send(ports, userId, 'POST', path, body);
  return sent.andThen((value) => answer(value, schema, label));
}

const POLL_ANSWER = z.object({ state: z.string(), result: z.unknown().optional() });

/** Poll a job at `path` (GET). A 404 is `notFound`: the runner restarted and lost it. */
export async function pollRunnerJob(
  ports: RunnerPorts,
  userId: string,
  path: string,
  notFound: string,
  label: string,
): Promise<Result<{ state: string; result?: unknown }, string>> {
  const sent = await send(ports, userId, 'GET', path, null);
  return sent.andThen((value) =>
    value.status === 404 ? err(notFound) : answer(value, POLL_ANSWER, label),
  );
}

/** Stop a job at `path` (DELETE), best effort: a failure is logged. */
export async function cancelRunnerJob(
  ports: RunnerPorts,
  userId: string,
  path: string,
  what: string,
): Promise<void> {
  const sent = await send(ports, userId, 'DELETE', path, null);
  if (sent.isOk() && (sent.value.status < 400 || sent.value.status === 404)) return;
  const error = sent.isErr() ? sent.error : `runner answered ${sent.value.status}`;
  log.warn(`Issue factory could not stop ${what}`, { namespace: 'factory', path, error });
}
