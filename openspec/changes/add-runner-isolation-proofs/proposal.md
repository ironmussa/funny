# Proposal

## Why

Runner isolation is the most critical invariant in funny: a request reaches ONLY a
runner owned by the user it is signed for. Today the server sends to a runner
through `RunnerRequestPort.request(runnerId: string, { headers })`, where the
runner id and the signed identity are two independent values that each of the
seven call sites pairs up on its own. Four different checks (resolver scoping,
an `isUserId === ownerId` comparison, an SQL filter, and no check at all) stand
between those values. `findRunnerForProject` / `resolveRunnerForProject` /
`resolveRunner` accept an optional `userId` and select ANY runner of the project
when it is missing, a mistake that already produced a cross-tenant routing bug.
The fork pilot (`add-thread-fork-authorization-proofs`) showed that gdp-ts
proofs can make this kind of pairing a compile-time obligation.

## What Changes

- Add a `RunnerFor<Actor, Runner>` proof (gdp-ts) stating that a runner is owned
  by the actor and is in scope for the target (project or projectless), issued
  ONLY by user-scoped runner resolution in the server.
- Add an authorized runner-request port that takes the named actor, the named
  runner and the proof, and **signs the forwarded identity itself** from the
  named actor. Callers no longer assemble identity headers for runner requests.
- Migrate every server → runner request sink to the authorized port:
  `middleware/proxy.ts`, `runner-forwarding.fetchFromRunner` (thread creation,
  fork, thread delete cleanup), `socketio/browser-session.ts`,
  `socketio/browser-v1-interactive.ts`, `routes/project-runner-settings.ts`
  (stop sessions) and both `routes/scheduler-system.ts` dispatch/cancel calls.
- Apply the same proof to the terminal sink (`RunnerTerminalPort.dispatch` /
  `listSessions`) used by `socketio/browser-pty.ts`.
- **BREAKING (internal API)**: `userId` becomes required in
  `findRunnerForProject`, `resolveRunnerForProject`, `resolveRunner` and
  `resolveRunnerDetailed`. The unauthenticated MCP OAuth callback keeps its
  "any runner" resolution through a separate, explicit proof
  (`OAuthCallbackRunner<Runner>`) that cannot be used for user requests.
- Scheduler system routes derive the request identity from the target thread's
  owner, not from the request body, and refuse a mismatching `userId` (the
  `/dispatch` route currently does not check it; `/cancel` already does).
- Add a fitness check that fails when `RunnerRequestPort.request` or
  `RunnerTerminalPort.dispatch` is called outside the authorized port, plus
  proof-lint fixtures for the new prover.
- Steer-share delegation keeps its current behavior. `proxy.ts` obtains its
  proof for the OWNER's runner through the existing gated path; turning the
  delegation itself into a proof is a separate follow-up change.

## Capabilities

### New Capabilities

- `runner-request-isolation`: every server → runner request and terminal
  dispatch carries evidence that the target runner belongs to, and is in scope
  for, the identity signed into that request; resolution never runs without an
  authenticated user (except the explicit OAuth callback path).

### Modified Capabilities

<!-- None. thread-access-control (per-thread route authorization) is unchanged. -->

## Impact

- **Code (server only)**: `services/runner-ports.ts`, `services/runner-resolver.ts`,
  `services/runner-manager.ts`, `services/runner-forwarding.ts`,
  `services/grpc/runner-request-adapter.ts`, `middleware/proxy.ts`,
  `services/socketio/{browser-session,browser-v1-interactive,browser-pty}.ts`,
  `routes/{project-runner-settings,scheduler-system,threads}.ts`,
  `modules/threads/infrastructure/runner-adapters.ts`,
  `services/runner-thread-launcher.ts`, `index.ts` wiring.
- **Tooling**: new `scripts/fitness/check-runner-request-sinks.ts`, wired into
  `bun run lint`; new fixtures in `scripts/fitness/check-proof-lint.ts`; new
  type-tests file in `packages/server/type-tests/`.
- **Tests**: about 21 server test files construct `runnerRequests` stubs. They
  keep working because the raw port interface is unchanged; only production
  callers move to the authorized port.
- **Runtime / client**: no change. The wire format of the signed identity is
  unchanged.
- **Out of scope**: steer delegation as a proof, the runner → server data channel
  (`data-scope.ts`), credentials, and signed media URLs (`routes/media.ts`).
  These are follow-up changes.
