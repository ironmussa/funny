/**
 * Runner-facing adapters: user-scoped runner resolution and remote thread
 * creation / forking over `services/runner-access` (runner-request-isolation).
 *
 * Resolution adapters select AND certify the actor's runner through
 * `withRunnerFor` and hand the use case a plain runner id. The remote adapters
 * certify that id again for the request's project (`{ kind: 'runner' }`) and
 * send through `AuthorizedRunnerRequests`, which signs the actor itself. A
 * proof never leaves the callback it was issued in.
 */

import { parseStoredJson } from '@funny/shared/json-validation';
import { z } from 'zod';

import {
  authorizedRunnerRequests,
  runnerActor,
  type RunnerAccess,
  type RunnerActor,
  type RunnerTarget,
} from '../../../services/runner-access/index.js';
import { runnerErrorMessage } from '../../../services/runner-forwarding.js';
import type { RunnerPresencePort, RunnerRequestPort } from '../../../services/runner-ports.js';
import type {
  ActorContext,
  CreationIntent,
  ForkVariant,
  RemoteCreationResponse,
  RemoteThreadCreationPort,
  RemoteThreadForkPort,
  RunnerResolution,
  RunnerResolutionPort,
  SourceRunnerResolutionPort,
} from '../application/ports.js';
import { resolvedRunnerId, type ThreadId } from '../domain/ids.js';

const RUNNER_PATHS: Record<CreationIntent, string> = {
  normal: '/api/threads',
  idle: '/api/threads/idle',
};

export const runnerPathFor = (intent: CreationIntent): string => RUNNER_PATHS[intent];

/**
 * Per-variant transport details for forking. The use case never sees these:
 * it only learns the runner's status and an already-formatted message.
 */
const FORK_VARIANTS: Record<
  ForkVariant,
  { path: (sourceId: ThreadId) => string; errorMessage: (rawBody: string) => string }
> = {
  fork: {
    path: (sourceId) => `/api/threads/${sourceId}/fork`,
    errorMessage: runnerErrorMessage,
  },
  'fork-and-rewind': {
    path: (sourceId) => `/api/threads/${sourceId}/fork-and-rewind`,
    errorMessage: (rawBody) => `Runner error: ${rawBody}`,
  },
};

export const forkRunnerPathFor = (variant: ForkVariant, sourceId: ThreadId): string =>
  FORK_VARIANTS[variant].path(sourceId);

/** The identity signed into runner requests, from the authenticated actor. */
function actorFor(actor: ActorContext): RunnerActor {
  return runnerActor({
    userId: actor.userId,
    role: actor.role,
    orgId: actor.organizationId,
    orgName: actor.organizationName,
  });
}

/** Scratch work resolves through the resolver's projectless route (legacy behavior). */
function scratchTarget(path: string): RunnerTarget {
  return { kind: 'request', path, query: {} };
}

export interface RunnerAdapterDeps {
  presence: RunnerPresencePort | undefined;
  requests?: RunnerRequestPort;
  access: RunnerAccess;
}

async function resolveWith(
  access: RunnerAccess,
  actor: ActorContext,
  target: RunnerTarget,
  presence: RunnerPresencePort | undefined,
): Promise<RunnerResolution> {
  const result = await access.withRunnerFor(actorFor(actor), target, presence, async (_a, runner) =>
    resolvedRunnerId(runner.value),
  );
  return result.isOk()
    ? { ok: true, runnerId: result.value }
    : { ok: false, reason: result.error.reason };
}

/**
 * Scratch targets resolve to one of the actor's general runners through the
 * resolver. Project targets use the actor-scoped checkout lookup and then the
 * resolver's scoped candidates. Both certify ownership and scope before a
 * runner id is returned, so another user's runner is never selected.
 */
export function createRunnerResolutionAdapter(deps: RunnerAdapterDeps): RunnerResolutionPort {
  return {
    resolve(actor, target, intent) {
      const runnerTarget: RunnerTarget =
        target.kind === 'scratch'
          ? scratchTarget(runnerPathFor(intent))
          : { kind: 'project', projectId: target.projectId };
      return resolveWith(deps.access, actor, runnerTarget, deps.presence);
    },
  };
}

/**
 * Forks resolve through the actor-scoped project lookup, exactly as before.
 * A scratch source (no project) resolves through the projectless route.
 */
export function createSourceRunnerResolutionAdapter(
  deps: RunnerAdapterDeps,
): SourceRunnerResolutionPort {
  return {
    resolve(actor, projectId) {
      const target: RunnerTarget = projectId
        ? { kind: 'project', projectId }
        : scratchTarget('/api/threads');
      return resolveWith(deps.access, actor, target, deps.presence);
    },
  };
}

/**
 * Certify `runnerId` for `projectId` (null = projectless) and POST through the
 * authorized sink. A refused certification throws, which the use case maps to
 * its `*-failed` outcome: the runner was selected a moment ago by the same
 * rules, so this only fires on a race or a bug.
 */
async function sendCertified(
  deps: RunnerAdapterDeps,
  actor: ActorContext,
  runnerId: string,
  projectId: string | null,
  path: string,
  body: string,
  errorMessage: (rawBody: string) => string,
  parseLabel: string,
): Promise<RemoteCreationResponse> {
  const sent = await deps.access.withRunnerFor(
    actorFor(actor),
    { kind: 'runner', runnerId, projectId },
    deps.presence,
    (a, runner, proof) =>
      authorizedRunnerRequests(deps.requests).send(a, runner, proof, {
        method: 'POST',
        path,
        headers: { 'Content-Type': 'application/json' },
        body,
      }),
  );
  if (sent.isErr()) {
    throw new Error(`runner ${runnerId} failed isolation certification (${sent.error.reason})`);
  }
  const response = sent.value;
  if (response.status < 200 || response.status >= 400) {
    return { ok: false, status: response.status, message: errorMessage(response.body ?? '') };
  }
  const parsed = parseStoredJson(z.unknown(), response.body ?? '', parseLabel);
  if (!parsed.ok) throw new Error(parsed.error);
  return { ok: true, thread: parsed.value };
}

/**
 * The success body is parsed but not validated: the runner's response goes
 * back to the client verbatim. Malformed JSON throws, which the use case maps
 * to `creation-failed`.
 */
export function createRemoteCreationAdapter(deps: RunnerAdapterDeps): RemoteThreadCreationPort {
  return {
    create(runnerId, actor, intent, payload) {
      const projectId =
        payload.isScratch === true
          ? null
          : typeof payload.projectId === 'string'
            ? payload.projectId
            : null;
      return sendCertified(
        deps,
        actor,
        runnerId,
        projectId,
        runnerPathFor(intent),
        JSON.stringify(payload),
        runnerErrorMessage,
        'runner thread creation response',
      );
    },
  };
}

/**
 * The raw request text is forwarded byte-for-byte. The success body is parsed
 * but not validated and goes back to the client verbatim. Malformed JSON
 * throws, which the use case maps to `fork-failed`.
 */
export function createRemoteForkAdapter(deps: RunnerAdapterDeps): RemoteThreadForkPort {
  return {
    fork(runnerId, actor, variant, sourceId, body, projectId) {
      return sendCertified(
        deps,
        actor,
        runnerId,
        projectId,
        forkRunnerPathFor(variant, sourceId),
        body,
        FORK_VARIANTS[variant].errorMessage,
        'runner thread fork response',
      );
    },
  };
}
