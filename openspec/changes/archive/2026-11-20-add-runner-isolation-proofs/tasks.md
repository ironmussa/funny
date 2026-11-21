# Tasks

## 1. Baseline and characterization

- [x] 1.1 Record the baseline: working-tree changes, current results of the runner-isolation, proxy, fork, thread-creation, browser socket, scheduler-system and project-runner-settings suites, plus `bun run lint` / `bun run typecheck`; verify unrelated modifications are identified and preserved.
- [x] 1.2 Add characterization tests for the sinks without route-level coverage: browser-session dispatch, browser-pty terminal routing, project-runner-settings stop-sessions and scheduler `/dispatch` / `/cancel` runner selection and signed identity; verify they pass against the current code.

## 2. Proof, prover and authorized sinks

- [x] 2.1 Add `RunnerActor`, `RunnerFor<A, R>` and `OAuthCallbackRunner<R>` with the private prover in `services/runner-access/` (ownership + `runner-scope` check), and the `withRunnerFor` callback returning `Result<_, RunnerUnavailable>`; verify unit tests cover the owner's runner, another user's runner, a dedicated runner for an unrelated project, a dedicated runner for projectless work, and the pinned-offline reason.
- [x] 2.2 Add `AuthorizedRunnerRequests.send` / `sendOAuthCallback` / `sendDelegated` and `AuthorizedRunnerTerminal`, stripping caller identity headers and signing the actor with a fresh nonce per send; verify tests show the request verifies with `verifyForwardedIdentity` for the actor, spoofed identity headers are dropped, and the OAuth variant signs nothing.
- [x] 2.3 Register `services/runner-access/runner-for.ts` as the trusted proof path in the Oxlint config and add proof-lint fixtures (forged `RunnerFor` cast, minting outside the trusted file, exported prover); verify `bun run lint:proofs` passes with every invalid fixture failing on its intended rule.
- [x] 2.4 Add `packages/server/type-tests/runner-isolation.ts` (missing proof, proof for another actor or runner, OAuth proof passed to `send`, names escaping the callback) and include it in `tsconfig.proofs.json`; verify `bun run typecheck:proofs` passes with no unused `@ts-expect-error`.

## 3. Required user in resolution

- [x] 3.1 Make `userId` required in `findRunnerForProject`, `resolveRunnerForProject`, `resolveRunner` and `resolveRunnerDetailed`, and keep `resolveAnyRunner` as the only userless resolver; verify the server typechecks and the runner-resolver / runner-scope suites pass.

## 4. Sink migration (one group per sink, tests in the same step)

- [x] 4.1 Add `scripts/fitness/check-runner-request-sinks.ts` with an allow-list of the not-yet-migrated files and a `--self-test`; wire it into `bun run lint`; verify it fails on a raw `.request(` in a non-allow-listed file and passes on the current tree.
- [x] 4.2 Migrate `runner-forwarding.fetchFromRunner` and its callers (thread creation and fork adapters, thread delete cleanup) to `withRunnerFor` + `send`, mapping `RunnerUnavailable` through `describeResolutionFailure`; remove them from the allow-list; verify the thread-creation, fork and fork-isolation suites pass and a pinned-offline fork now returns the `project-runner-offline` code.
- [x] 4.3 Migrate `socketio/browser-session.ts` and `socketio/browser-v1-interactive.ts`; verify the browser socket tests and the 1.2 characterization tests pass and no request reaches a runner of another user.
- [x] 4.4 Migrate `socketio/browser-pty.ts` to `AuthorizedRunnerTerminal`; verify the PTY tests pass and the cross-tenant refusal is still audited.
- [x] 4.5 Migrate `routes/project-runner-settings.ts` stop-sessions, deriving the actor from the project owner and certifying each revoked runner; verify the project-runner-settings suite passes and a runner not owned by the project owner is skipped.
- [x] 4.6 Migrate `routes/scheduler-system.ts` `/dispatch` and `/cancel`, deriving the actor from the thread owner and refusing a mismatching `body.userId` on `/dispatch` with an audit record; verify scheduler-system tests cover the match, the mismatch (no runner contacted) and the unknown-run fallback.
- [x] 4.7 Migrate `middleware/proxy.ts`: the normal path through `send`, steer delegation through `sendDelegated`, and the OAuth callback through `sendOAuthCallback`, keeping Range/Host/Proto/binary handling; verify the proxy, steer-delegation, media and OAuth tests pass and the `share.steer_delegation` audit is still emitted.
- [x] 4.8 Restrict `sendDelegated` to `middleware/proxy.ts` in the fitness check; verify a fixture calling it from another file fails.

## 5. Documentation

- [x] 5.1 Update the CLAUDE.md "Runner Isolation (CRITICAL)" section and OpenWiki (operations/auth and development workflow) with the authorized sink, the proof, the OAuth exception and the fitness check; verify the documented paths and commands exist.

## 6. Integration validation

- [x] 6.1 Verify the fitness allow-list is empty, then run `bun run lint`, `bun run typecheck` and the full server test suite; verify no new diagnostics, no suppressions and no baseline refresh.
- [x] 6.2 Review the final diff against the spec scenarios and design decisions; verify the signed-identity wire format, the runtime and the client are unchanged, and that no proof is serialized.
