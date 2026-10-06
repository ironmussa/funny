/**
 * Runner-facing adapters: user-scoped runner resolution and remote thread
 * creation over the existing runner services and signed identity forwarding.
 */

import { parseStoredJson } from '@funny/shared/json-validation';
import { z } from 'zod';

import {
  buildForwardHeaders,
  fetchFromRunner,
  resolveRunnerForProject,
  runnerErrorMessage,
} from '../../../services/runner-forwarding.js';
import type { RunnerPresencePort, RunnerRequestPort } from '../../../services/runner-ports.js';
import * as runnerResolver from '../../../services/runner-resolver.js';
import type {
  CreationIntent,
  RemoteThreadCreationPort,
  RunnerResolutionPort,
} from '../application/ports.js';
import { resolvedRunnerId } from '../domain/ids.js';

const RUNNER_PATHS: Record<CreationIntent, string> = {
  normal: '/api/threads',
  idle: '/api/threads/idle',
};

export const runnerPathFor = (intent: CreationIntent): string => RUNNER_PATHS[intent];

/**
 * Scratch targets resolve to any online runner owned by the actor. Project
 * targets use the actor-scoped project lookup and then fall back to the
 * actor-scoped resolver. Both paths take the authenticated user id, so another
 * user's runner is never selected.
 */
export function createRunnerResolutionAdapter(
  presence: RunnerPresencePort | undefined,
): RunnerResolutionPort {
  return {
    async resolve(actor, target, intent) {
      const resolved =
        target.kind === 'scratch'
          ? await runnerResolver.resolveRunner(runnerPathFor(intent), {}, actor.userId, presence)
          : await resolveRunnerForProject(target.projectId, actor.userId, presence);
      return resolved ? resolvedRunnerId(resolved.runnerId) : null;
    },
  };
}

/**
 * The success body is parsed but not validated: the runner's response goes
 * back to the client verbatim. Malformed JSON throws, which the use case maps
 * to `creation-failed`.
 */
export function createRemoteCreationAdapter(
  requests: RunnerRequestPort | undefined,
): RemoteThreadCreationPort {
  return {
    async create(runnerId, actor, intent, payload) {
      const headers = buildForwardHeaders(
        actor.userId,
        actor.organizationId,
        actor.role,
        actor.organizationName,
      );
      // A missing transport throws here (inside the use case's failure
      // boundary), the same as the legacy `c.env.runnerRequests!` access.
      const result = await fetchFromRunner(requests!, { runnerId }, runnerPathFor(intent), {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });
      if (!result.ok) {
        return { ok: false, status: result.status, message: runnerErrorMessage(result.body) };
      }
      const parsed = parseStoredJson(z.unknown(), result.body, 'runner thread creation response');
      if (!parsed.ok) throw new Error(parsed.error);
      return { ok: true, thread: parsed.value };
    },
  };
}
