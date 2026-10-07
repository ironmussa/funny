/**
 * The ONLY prover for runner isolation (runner-request-isolation).
 *
 * `RunnerFor<A, R>` states that runner `R` is owned by actor `A` and is in
 * scope for the target the request is for. `OAuthCallbackRunner<R>` states
 * that `R` is a connected general runner and nothing else; it is accepted only
 * by the identity-free OAuth callback send.
 *
 * The resolver still CHOOSES the runner (ordering, presence, the pinned
 * no-fallback rule). This module CERTIFIES the result independently:
 *   1. the runner belongs to the actor (presence first, then `runners.user_id`);
 *   2. `runner-scope` allows the runner for the target (project or projectless).
 * A runner that fails certification is refused and audited, whatever the
 * resolver said. Names and proofs cannot leave the callback, so a proof is
 * bound to one actor, one runner, and one operation.
 *
 * Dependencies are injectable so tests can run without the DB. Production
 * code uses `runnerAccess` (the defaults); `createRunnerAccess` is restricted
 * to this directory and tests by `scripts/fitness/check-runner-request-sinks.ts`.
 */

import { defineProof, name, type Named, type Proof } from '@gdp-ts/core';
import { err, ok, type Result } from 'neverthrow';

import { audit } from '../../lib/audit.js';
import { log } from '../../lib/logger.js';
import * as runnerManager from '../runner-manager.js';
import type { RunnerPresencePort } from '../runner-ports.js';
import * as runnerResolver from '../runner-resolver.js';
import type { RouteTarget, RunnerResolutionFailure } from '../runner-resolver.js';
import * as runnerScope from '../runner-scope.js';
import {
  resolvedRunnerId,
  type RunnerActor,
  type RunnerId,
  type RunnerTarget,
  type RunnerUnavailable,
} from './runner-actor.js';

const RunnerFor = defineProof('RunnerFor');
/** Runner `R` is owned by actor `A` and in scope for the request's target. */
export interface RunnerFor<A, R> extends Proof<'RunnerFor', [A, R]> {}

const OAuthCallbackRunner = defineProof('OAuthCallbackRunner');
/** Runner `R` is a connected general runner; no identity is certified. */
export interface OAuthCallbackRunner<R> extends Proof<'OAuthCallbackRunner', [R]> {}

export type Selected =
  | { readonly ok: true; readonly runnerId: string }
  | { readonly ok: false; readonly reason: RunnerResolutionFailure; readonly projectId?: string };

/** How runners are chosen. Production defaults delegate to the existing resolvers. */
export interface RunnerSelection {
  anyRunnerForUser(userId: string): Promise<string | null>;
  runnerForProject(projectId: string, userId: string): Promise<string | null>;
  resolveRequest(
    path: string,
    query: Record<string, string>,
    userId: string,
    presence: RunnerPresencePort | undefined,
  ): Promise<Selected>;
  pinnedRunnerIdsForProject(projectId: string, userId: string): Promise<string[] | null>;
  anyGeneralRunner(presence: RunnerPresencePort | undefined): Promise<string | null>;
}

/** How a chosen runner is certified. Production defaults read `runners` and `runner-scope`. */
export interface RunnerVerification {
  runnerOwner(runnerId: string): Promise<string | null>;
  canAccessProject(runnerId: string, projectId: string): Promise<boolean>;
  canServeProjectless(runnerId: string): Promise<boolean>;
  routeTarget(path: string, query: Record<string, string>): Promise<RouteTarget>;
}

export interface RunnerAccessDeps {
  selection?: Partial<RunnerSelection>;
  verification?: Partial<RunnerVerification>;
}

export type WithRunnerFor = <T>(
  actor: RunnerActor,
  target: RunnerTarget,
  presence: RunnerPresencePort | undefined,
  run: <A, R>(
    actor: Named<A, RunnerActor>,
    runner: Named<R, RunnerId>,
    proof: RunnerFor<A, R>,
  ) => Promise<T>,
) => Promise<Result<T, RunnerUnavailable>>;

export type WithOAuthCallbackRunner = <T>(
  presence: RunnerPresencePort | undefined,
  run: <R>(runner: Named<R, RunnerId>, proof: OAuthCallbackRunner<R>) => Promise<T>,
) => Promise<Result<T, RunnerUnavailable>>;

export interface RunnerAccess {
  withRunnerFor: WithRunnerFor;
  withOAuthCallbackRunner: WithOAuthCallbackRunner;
}

// Called through the namespaces at call time so test spies on the real
// services take effect (same pattern as the proxy's default transport).
const productionSelection: RunnerSelection = {
  anyRunnerForUser: (userId) => runnerManager.findAnyRunnerForUser(userId),
  runnerForProject: async (projectId, userId) =>
    (await runnerManager.findRunnerForProject(projectId, userId))?.runner.runnerId ?? null,
  resolveRequest: async (path, query, userId, presence) => {
    const resolved = await runnerResolver.resolveRunnerDetailed(path, query, userId, presence);
    return resolved.ok
      ? { ok: true, runnerId: resolved.runnerId }
      : { ok: false, reason: resolved.reason, projectId: resolved.projectId };
  },
  pinnedRunnerIdsForProject: (projectId, userId) =>
    runnerScope.pinnedRunnerIdsForProject(projectId, userId),
  anyGeneralRunner: async (presence) =>
    (await runnerResolver.resolveAnyRunner(presence))?.runnerId ?? null,
};

const productionVerification: RunnerVerification = {
  runnerOwner: (runnerId) => runnerManager.getRunnerUserId(runnerId),
  canAccessProject: (runnerId, projectId) =>
    runnerScope.canRunnerAccessProject(runnerId, projectId),
  canServeProjectless: (runnerId) => runnerScope.canRunnerServeProjectless(runnerId),
  routeTarget: (path, query) => runnerResolver.resolveRouteTarget(path, query),
};

function targetProjectId(target: RunnerTarget): string | undefined {
  switch (target.kind) {
    case 'project':
    case 'project-checkout':
      return target.projectId;
    case 'runner':
      return target.projectId ?? undefined;
    default:
      return undefined;
  }
}

export function createRunnerAccess(deps: RunnerAccessDeps = {}): RunnerAccess {
  const selection: RunnerSelection = { ...productionSelection, ...deps.selection };
  const verification: RunnerVerification = { ...productionVerification, ...deps.verification };

  async function select(
    actor: RunnerActor,
    target: RunnerTarget,
    presence: RunnerPresencePort | undefined,
  ): Promise<Selected> {
    switch (target.kind) {
      case 'request':
        return selection.resolveRequest(target.path, target.query, actor.userId, presence);
      case 'project': {
        // The runner holding the checkout first, then the resolver's scoped
        // candidates (mirrors the legacy `resolveRunnerForProject`).
        const checkout = await selection.runnerForProject(target.projectId, actor.userId);
        if (checkout && presence?.isAvailable(checkout)) return { ok: true, runnerId: checkout };
        return selection.resolveRequest(
          '/api/threads',
          { projectId: target.projectId },
          actor.userId,
          presence,
        );
      }
      case 'project-checkout': {
        const runnerId = await selection.runnerForProject(target.projectId, actor.userId);
        if (runnerId) return { ok: true, runnerId };
        const pinned = await selection.pinnedRunnerIdsForProject(target.projectId, actor.userId);
        return {
          ok: false,
          reason: pinned ? 'project-runner-offline' : 'general-runner-offline',
          projectId: target.projectId,
        };
      }
      case 'projectless': {
        const runnerId = await selection.anyRunnerForUser(actor.userId);
        return runnerId ? { ok: true, runnerId } : { ok: false, reason: 'general-runner-offline' };
      }
      case 'runner':
      case 'owned-runner':
        return { ok: true, runnerId: target.runnerId };
    }
  }

  async function inScope(runnerId: string, target: RunnerTarget): Promise<boolean> {
    switch (target.kind) {
      case 'project':
      case 'project-checkout':
        return verification.canAccessProject(runnerId, target.projectId);
      case 'projectless':
        return verification.canServeProjectless(runnerId);
      case 'request': {
        const route = await verification.routeTarget(target.path, target.query);
        return route.kind === 'project'
          ? verification.canAccessProject(runnerId, route.projectId)
          : verification.canServeProjectless(runnerId);
      }
      case 'runner':
        return target.projectId
          ? verification.canAccessProject(runnerId, target.projectId)
          : verification.canServeProjectless(runnerId);
      case 'owned-runner':
        return true;
    }
  }

  /** Independent re-check of the (actor, runner, target) triple. */
  async function certify(
    actor: RunnerActor,
    runnerId: string,
    target: RunnerTarget,
    presence: RunnerPresencePort | undefined,
  ): Promise<'ok' | 'ownership' | 'scope'> {
    const owner =
      presence?.userIdForRunner?.(runnerId) ?? (await verification.runnerOwner(runnerId));
    if (!owner || owner !== actor.userId) return 'ownership';
    return (await inScope(runnerId, target)) ? 'ok' : 'scope';
  }

  function refused(
    actor: RunnerActor,
    runnerId: string,
    target: RunnerTarget,
    failure: 'ownership' | 'scope',
  ): RunnerUnavailable {
    const projectId = targetProjectId(target);
    log.error('Runner failed isolation certification — request refused', {
      namespace: 'runner-access',
      userId: actor.userId,
      runnerId,
      target: target.kind,
      projectId: projectId ?? null,
      failure,
    });
    audit({
      action: failure === 'ownership' ? 'authz.cross_tenant_refused' : 'runner.scope_denied',
      actorId: actor.userId,
      detail:
        failure === 'ownership'
          ? 'Runner request refused — runner not owned by the signed identity'
          : 'Runner request refused — runner out of scope for the target',
      meta: {
        source: 'runner-access',
        runnerId,
        target: target.kind,
        projectId: projectId ?? null,
      },
    });
    return { kind: 'runner-unavailable', reason: 'general-runner-offline', projectId };
  }

  const withRunnerFor: WithRunnerFor = async (actor, target, presence, run) => {
    const selected = await select(actor, target, presence);
    if (!selected.ok) {
      return err({
        kind: 'runner-unavailable',
        reason: selected.reason,
        projectId: selected.projectId,
      });
    }
    const verdict = await certify(actor, selected.runnerId, target, presence);
    if (verdict !== 'ok') return err(refused(actor, selected.runnerId, target, verdict));
    return ok(
      await name(Object.freeze({ ...actor }), resolvedRunnerId(selected.runnerId), (a, r) =>
        run(a, r, RunnerFor.prove(a, r)),
      ),
    );
  };

  const withOAuthCallbackRunner: WithOAuthCallbackRunner = async (presence, run) => {
    const runnerId = await selection.anyGeneralRunner(presence);
    if (!runnerId) return err({ kind: 'runner-unavailable', reason: 'general-runner-offline' });
    return ok(await name(resolvedRunnerId(runnerId), (r) => run(r, OAuthCallbackRunner.prove(r))));
  };

  return { withRunnerFor, withOAuthCallbackRunner };
}

/** Production access: real resolvers, `runners.user_id`, and `runner-scope`. */
export const runnerAccess: RunnerAccess = createRunnerAccess();

export const withRunnerFor: WithRunnerFor = (actor, target, presence, run) =>
  runnerAccess.withRunnerFor(actor, target, presence, run);

export const withOAuthCallbackRunner: WithOAuthCallbackRunner = (presence, run) =>
  runnerAccess.withOAuthCallbackRunner(presence, run);
