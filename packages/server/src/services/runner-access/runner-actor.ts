/**
 * Values the runner-access proofs are about.
 *
 *  - `RunnerActor`: the identity that will be SIGNED into a server → runner
 *    request. Always built from the authenticated session or from the owner of
 *    the resource a system component acts on — never from a request body.
 *  - `RunnerId`: a runner selected by user-scoped resolution. The brand is
 *    minted only in `services/runner-access/`.
 *  - `RunnerTarget`: what the request is for. It decides how the runner is
 *    selected and which `runner-scope` rule certifies it.
 *
 * This file has no I/O. The checks live in `runner-for.ts`.
 */

import type { RunnerResolutionFailure } from '../runner-resolver.js';

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

/** A runner id produced by user-scoped resolution in this module. */
export type RunnerId = Brand<string, 'RunnerId'>;

/** Wrap a runner id that `runner-for.ts` selected. Not for use outside this module. */
export const resolvedRunnerId = (value: string): RunnerId => value as RunnerId;

/** The identity signed into a runner request (`signForwardedIdentity` fields). */
export interface RunnerActor {
  readonly userId: string;
  readonly role: string;
  readonly orgId: string | null;
  readonly orgName: string | null;
}

export interface RunnerActorInput {
  userId: string;
  role?: string | null;
  orgId?: string | null;
  orgName?: string | null;
}

/**
 * Build a frozen actor. The role defaults to `user` so the signed payload
 * matches what the runtime verifies (it defaults a missing role to `user`).
 */
export function runnerActor(input: RunnerActorInput): RunnerActor {
  return Object.freeze({
    userId: input.userId,
    role: input.role || 'user',
    orgId: input.orgId ?? null,
    orgName: input.orgName ?? null,
  });
}

/**
 * What a runner is being selected and certified for.
 *
 *  - `project`: the actor's runner holding the project checkout, then the
 *    resolver's scoped candidates (thread creation and fork).
 *  - `project-checkout`: only a runner of the actor holding the checkout
 *    (terminals and browser sessions need the files on disk).
 *  - `projectless`: one of the actor's general runners (browser sessions,
 *    terminals without a project, run cancellation fallback).
 *  - `request`: the resolver's route-based selection (proxied HTTP requests,
 *    scheduler dispatch by thread).
 *  - `runner`: a runner chosen elsewhere; certified for the given project
 *    (null = projectless) before it is used.
 *  - `owned-runner`: a runner chosen elsewhere; certified for ownership only.
 *    For cleanup on a runner that may have just LOST project access (stop
 *    sessions after a binding change, delete a thread's runner-side state).
 */
export type RunnerTarget =
  | { readonly kind: 'project'; readonly projectId: string }
  | { readonly kind: 'project-checkout'; readonly projectId: string }
  | { readonly kind: 'projectless' }
  | { readonly kind: 'request'; readonly path: string; readonly query: Record<string, string> }
  | { readonly kind: 'runner'; readonly runnerId: string; readonly projectId: string | null }
  | { readonly kind: 'owned-runner'; readonly runnerId: string };

/** Why no runner could be certified for the actor and target. */
export interface RunnerUnavailable {
  readonly kind: 'runner-unavailable';
  readonly reason: RunnerResolutionFailure;
  readonly projectId?: string;
}
