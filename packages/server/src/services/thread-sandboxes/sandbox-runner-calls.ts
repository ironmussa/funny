/**
 * Server → runner calls the sandbox lifecycle needs (change thread-sandboxes).
 * Every call goes through runner-access: the runner is certified for the actor
 * and target, and the forwarded identity is signed by the sink.
 *
 * - checkout: to the THREAD's sandbox runner (the `request` target resolves to
 *   the thread-sandbox route target, so no other runner can be certified).
 * - projectRemoteUrl: to the PROJECT's runner, to learn the repository URL.
 */

import { parseStoredJson } from '@funny/shared/json-validation';
import { errAsync, okAsync, ResultAsync } from 'neverthrow';
import { z } from 'zod';

import {
  authorizedRunnerRequests,
  runnerActor,
  withRunnerFor,
  type RunnerTarget,
  type UnsignedRunnerRequest,
} from '../runner-access/index.js';
import type { RunnerPresencePort, RunnerRequestPort, RunnerResponse } from '../runner-ports.js';

const remoteUrlSchema = z.object({ remoteUrl: z.string().nullable() });

const CHECKOUT_TIMEOUT_MS = 10 * 60_000;

export function createSandboxRunnerCalls(ports: {
  requests?: RunnerRequestPort;
  presence?: RunnerPresencePort;
}) {
  const sink = authorizedRunnerRequests(ports.requests);

  const send = (
    userId: string,
    target: RunnerTarget,
    request: UnsignedRunnerRequest,
  ): ResultAsync<RunnerResponse, string> =>
    ResultAsync.fromPromise(
      withRunnerFor(runnerActor({ userId }), target, ports.presence, (actor, runner, proof) =>
        sink.send(actor, runner, proof, request),
      ),
      (error) => (error instanceof Error ? error.message : String(error)),
    ).andThen((result) =>
      result.isOk()
        ? okAsync<RunnerResponse, string>(result.value)
        : errAsync<RunnerResponse, string>(`runner unavailable: ${result.error.reason}`),
    );

  return {
    /** Clone the thread's project at its canonical path on the sandbox runner. */
    checkout(input: {
      userId: string;
      threadId: string;
      path: string;
      repoUrl: string;
    }): ResultAsync<void, string> {
      const path = `/api/threads/${encodeURIComponent(input.threadId)}/sandbox/checkout`;
      return send(
        input.userId,
        { kind: 'request', path, query: {} },
        {
          method: 'POST',
          path,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: input.path, repoUrl: input.repoUrl }),
          deadlineAt: Date.now() + CHECKOUT_TIMEOUT_MS,
        },
      ).andThen((res) =>
        res.status >= 200 && res.status < 300
          ? okAsync<void, string>(undefined)
          : errAsync<void, string>(`checkout failed (${res.status}): ${res.body.slice(0, 500)}`),
      );
    },

    /** The project's `origin` URL, read by the runner that holds its checkout. */
    projectRemoteUrl(input: {
      userId: string;
      projectId: string;
    }): ResultAsync<string | null, string> {
      const path = `/api/git/project/${encodeURIComponent(input.projectId)}/remote-url`;
      return send(
        input.userId,
        { kind: 'project', projectId: input.projectId },
        { method: 'GET', path, headers: {} },
      ).andThen((res) => {
        if (res.status < 200 || res.status >= 300) {
          return errAsync<string | null, string>(`remote-url failed (${res.status})`);
        }
        const parsed = parseStoredJson(remoteUrlSchema, res.body, 'runner remote-url');
        return parsed.ok
          ? okAsync<string | null, string>(parsed.value.remoteUrl)
          : errAsync<string | null, string>(parsed.error);
      });
    },
  };
}

export type SandboxRunnerCalls = ReturnType<typeof createSandboxRunnerCalls>;
