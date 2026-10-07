/**
 * Runner-request isolation (runner-request-isolation).
 *
 * Every server → runner request or terminal message carries a `RunnerFor`
 * proof that the target runner belongs to, and is in scope for, the identity
 * signed into it. Use:
 *
 *   withRunnerFor(runnerActor(session), target, presence, (actor, runner, proof) =>
 *     authorizedRunnerRequests(port).send(actor, runner, proof, { method, path, body }))
 *
 * The only prover is `runner-for.ts`. The only sinks are in
 * `authorized-runner-requests.ts`. `scripts/fitness/check-runner-request-sinks.ts`
 * fails the build when a raw `RunnerRequestPort.request` or
 * `RunnerTerminalPort.dispatch/listSessions` call appears anywhere else.
 */

export {
  runnerActor,
  type RunnerActor,
  type RunnerActorInput,
  type RunnerId,
  type RunnerTarget,
  type RunnerUnavailable,
} from './runner-actor.js';
export {
  createRunnerAccess,
  runnerAccess,
  withOAuthCallbackRunner,
  withRunnerFor,
  type OAuthCallbackRunner,
  type RunnerAccess,
  type RunnerAccessDeps,
  type RunnerFor,
  type RunnerSelection,
  type RunnerVerification,
  type Selected,
  type WithOAuthCallbackRunner,
  type WithRunnerFor,
} from './runner-for.js';
export {
  AuthorizedRunnerRequests,
  AuthorizedRunnerTerminal,
  authorizedRunnerRequests,
  authorizedRunnerTerminal,
  stripIdentityHeaders,
  type UnsignedRunnerRequest,
} from './authorized-runner-requests.js';
