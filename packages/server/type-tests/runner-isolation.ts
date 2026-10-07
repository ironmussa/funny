// Compile only. This file is never executed by the runtime test runner.
import type { Named, Proof } from '@gdp-ts/core';

import {
  authorizedRunnerRequests,
  authorizedRunnerTerminal,
  runnerActor,
  withOAuthCallbackRunner,
  withRunnerFor,
  type OAuthCallbackRunner,
  type RunnerActor,
  type RunnerFor,
  type RunnerId,
} from '../src/services/runner-access/index.js';
import type { RunnerRequestPort, RunnerTerminalPort } from '../src/services/runner-ports.js';

declare const port: RunnerRequestPort;
declare const terminalPort: RunnerTerminalPort;
const requests = authorizedRunnerRequests(port);
const terminal = authorizedRunnerTerminal(terminalPort);
const actorInput = runnerActor({ userId: 'owner' });
const request = { method: 'POST', path: '/api/threads/t1/stop' };
const event = { type: 'pty:write' as const, data: { id: 'pty-1', data: 'ls\n' } };

withRunnerFor(actorInput, { kind: 'projectless' }, undefined, async (actor, runner, proof) => {
  await requests.send(actor, runner, proof, request);
  terminal.dispatch(actor, runner, proof, event);
  terminal.listSessions(actor, runner, proof);
  // @ts-expect-error The proof is mandatory.
  await requests.send(actor, runner, request);
  // @ts-expect-error The raw runner id cannot replace the named runner.
  await requests.send(actor, runner.value, proof, request);
  // @ts-expect-error The raw actor cannot replace the named actor.
  await requests.send(actorInput, runner, proof, request);
  // @ts-expect-error A terminal message needs the proof too.
  terminal.dispatch(actor, runner, event);

  await withRunnerFor(
    actorInput,
    { kind: 'projectless' },
    undefined,
    async (other, otherRunner, otherProof) => {
      // @ts-expect-error A proof about another scope's actor is not about this actor.
      await requests.send(actor, runner, otherProof, request);
      // @ts-expect-error Even an equal runtime id is a different name in another scope.
      await requests.send(actor, otherRunner, proof, request);
      // @ts-expect-error The actor of one scope cannot use the runner of another.
      await requests.send(other, runner, proof, request);
      // @ts-expect-error Evidence belongs to exactly one (actor, runner) pair.
      terminal.listSessions(other, runner, proof);
    },
  );
});

withOAuthCallbackRunner(undefined, async (runner, proof) => {
  await requests.sendOAuthCallback(runner, proof, request);
  // @ts-expect-error An OAuth proof certifies no actor, so it cannot authorize `send`.
  await requests.send(actorInput, runner, proof, request);
});

export function reversedNames<A, R>(
  actor: Named<A, RunnerActor>,
  runner: Named<R, RunnerId>,
  reversed: RunnerFor<R, A>,
) {
  // @ts-expect-error Evidence about (runner, actor) is not evidence about (actor, runner).
  return requests.send(actor, runner, reversed, request);
}

export function wrongKind<A, R>(
  actor: Named<A, RunnerActor>,
  runner: Named<R, RunnerId>,
  other: Proof<'ThreadOwnedBy', [A, R]>,
) {
  // @ts-expect-error Thread ownership is not runner ownership.
  return requests.send(actor, runner, other, request);
}

export function oauthForUser<A, R>(
  actor: Named<A, RunnerActor>,
  runner: Named<R, RunnerId>,
  oauth: OAuthCallbackRunner<R>,
) {
  // @ts-expect-error The OAuth proof kind never satisfies `RunnerFor`.
  return requests.send(actor, runner, oauth, request);
}

export function userProofForOAuth<A, R>(runner: Named<R, RunnerId>, proof: RunnerFor<A, R>) {
  // @ts-expect-error A user-bound proof is not accepted by the identity-free OAuth send.
  return requests.sendOAuthCallback(runner, proof, request);
}

withRunnerFor(
  actorInput,
  { kind: 'projectless' },
  undefined,
  // @ts-expect-error A proof cannot escape its naming callback.
  async (_actor, _runner, proof) => proof,
);
withRunnerFor(
  actorInput,
  { kind: 'projectless' },
  undefined,
  // @ts-expect-error A named runner cannot escape wrapped in another object either.
  async (_actor, runner) => ({ runner }),
);
