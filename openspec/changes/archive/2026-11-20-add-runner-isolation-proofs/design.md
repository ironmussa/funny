# Design

## Context

See proposal.md for motivation and `specs/runner-request-isolation/spec.md` for the
required behavior.

Current server → runner sinks (production code, `packages/server/src`):

| Sink                                                                      | Runner comes from                                                        | Identity signed for                    | Pairing check today                          |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------- | -------------------------------------------- |
| `middleware/proxy.ts` (`requests.request`)                                | `resolveRunner(path, query, resolveUserId)` / `resolveAnyRunner` (OAuth) | sharee or owner (steer) / none (OAuth) | resolver internals + steer gate              |
| `runner-forwarding.fetchFromRunner` (thread create, fork, delete cleanup) | `resolveRunnerForProject(projectId, userId?)` / `resolveRunner`          | actor                                  | resolver internals; `userId` optional        |
| `socketio/browser-session.ts`                                             | `findAnyRunnerForUser(userId)`                                           | `userId`                               | SQL filter                                   |
| `socketio/browser-v1-interactive.ts`                                      | `findRunnerForProject` / `findAnyRunnerForUser`                          | principal                              | inline `getRunnerUserId === principal`       |
| `routes/project-runner-settings.ts` (stop sessions)                       | `threads.runner_id` column                                               | project owner                          | none                                         |
| `routes/scheduler-system.ts` `/dispatch`, `/cancel`                       | `resolveRunner` / `findAnyRunnerForUser`                                 | `body.userId`                          | `/cancel` checks owner, `/dispatch` does not |
| `RunnerTerminalPort.dispatch/listSessions` via `socketio/browser-pty.ts`  | `findRunnerForProject` / `findAnyRunnerForUser`                          | `userId`                               | inline `getRunnerUserId` guard               |

The single authority on "may runner R serve target T" is `services/runner-scope.ts`
(`canRunnerAccessProject`, `canRunnerServeProjectless`). Ownership of a runner is
`runners.user_id`. The forwarded identity is HMAC-signed with
`signForwardedIdentity` (`@funny/shared/auth/forwarded-identity`); the wire format
must not change.

gdp-ts is already a dependency, with the Oxlint preset (`no-define-proof`,
`no-exported-prover`, `no-proof-assertion`), `lint:proofs` fixtures and
`typecheck:proofs`, introduced by `add-thread-fork-authorization-proofs`.

## Goals / Non-Goals

**Goals:**

- Make "runner R is owned by the signed identity A and serves target T" a
  compile-time obligation at every sink, with exactly one trusted prover.
- Move identity signing into the sink, so the signed identity is the one
  checked, by construction.
- Make the "no user" case unrepresentable in user-facing resolution.

**Non-Goals:**

- Turning steer delegation into its own proof (follow-up change). This change
  keeps today's gated behavior and routes it through a narrow, allow-listed method.
- The runner → server data channel (`data-scope.ts`, `data-handler.ts`),
  credentials, and signed media URLs.
- Any runtime-side change. The runtime keeps verifying the HMAC exactly as today.

## Decisions

### D1. One proof, issued by one trusted module

`RunnerFor<A, R>` (gdp-ts `Proof<'RunnerFor', [A, R]>`) over
`Named<A, RunnerActor>` and `Named<R, RunnerId>`. `RunnerActor` is the identity
that will be signed: `{ userId, role, orgId, orgName }`, frozen.

The only prover lives in `services/runner-access/runner-for.ts` (the trusted
path in the Oxlint config). It **re-verifies** the pair instead of trusting the
resolver's internals:

1. `runners.user_id === actor.userId` (DB or presence `userIdForRunner`), and
2. `canRunnerAccessProject(runner, projectId)` for a project target, or
   `canRunnerServeProjectless(runner)` for a projectless target.

The resolver still chooses the runner (ordering, presence, the pinned
no-fallback rule). The prover only certifies the result. That keeps the proof
correct even if a resolver strategy is later added or changed.

_Alternative considered:_ make the resolver itself the prover. Rejected: the
resolver has five strategies and a cache; certifying its output in one small
function is easier to audit than proving every branch.

### D2. Named-scope callback API, like fork

```ts
withRunnerFor(actor, target, presence, (actor, runner, proof) => …)
  → Promise<Result<T, RunnerUnavailable>>
```

Names cannot escape the callback, so a proof for one request cannot be reused
for another actor or runner. `RunnerUnavailable` carries
`'project-runner-offline' | 'general-runner-offline'` so callers map it with the
existing `describeResolutionFailure`.

### D3. Authorized sink signs the identity

`AuthorizedRunnerRequests` (wraps `RunnerRequestPort`) and
`AuthorizedRunnerTerminal` (wraps `RunnerTerminalPort`):

```ts
send<A, R>(actor: Named<A, RunnerActor>, runner: Named<R, RunnerId>,
           proof: RunnerFor<A, R>, request: UnsignedRunnerRequest)
```

`UnsignedRunnerRequest` carries method, path, body, signal and non-identity
headers. The sink **removes** any caller-supplied identity headers (`X-Forwarded-*`
identity fields, `X-Runner-Auth`, signature, timestamp, nonce, share claims),
then signs `actor.value` with a fresh nonce immediately before the physical
send. This preserves the proxy's "fresh signature per send" behavior.

### D4. Interim steer delegation: one allow-listed method

`proxy.ts` keeps the existing gate (thread loaded by `requireThreadSteer`, owner
≠ requester, audit). For that path it obtains `RunnerFor<Owner, R>` by resolving
as the **owner** and calls `sendDelegated(ownerProof…, sharee, threadId)`, which
signs the sharee with `shareLevel: 'steer'` + `onBehalfOfThread`. The
`runner-request-sinks` fitness check allows `sendDelegated` only from
`middleware/proxy.ts`. The follow-up change replaces this with a
`SteerDelegation` proof.

### D5. OAuth callback: a separate, weaker proof

`OAuthCallbackRunner<R>` comes only from `resolveAnyRunner` and is accepted only
by `sendOAuthCallback`, which signs no identity (today's behavior). It is a
different proof kind, so it cannot satisfy `send`.

### D6. `userId` becomes required

`findRunnerForProject`, `resolveRunnerForProject`, `resolveRunner` and
`resolveRunnerDetailed` take `userId: string`. Every production caller already
passes one; the type change removes the "any runner of the project" branch for
good. `resolveAnyRunner` stays as the only userless resolver, used only by D5.

### D7. System callers derive the actor from the resource owner

`scheduler-system` `/dispatch` and `/cancel` and `project-runner-settings`
build the `RunnerActor` from the owner of the thread or project they act on,
read from the DB. `/dispatch` refuses when `body.userId` does not match the
thread owner (new; `/cancel` already did this). The scheduler stays
authenticated by `X-Scheduler-Auth`; only the identity source changes.

### D8. Incremental migration enforced by a fitness check

The raw `RunnerRequestPort` / `RunnerTerminalPort` interfaces stay unchanged, so
the 21 test files that stub them keep working. Production callers move one by
one. `scripts/fitness/check-runner-request-sinks.ts` fails when `.request(` on a
runner-request port or `.dispatch(`/`.listSessions(` on a terminal port appears
outside `services/runner-access/` and the gRPC adapters. It starts with an
allow-list of the not-yet-migrated files and ends empty (final task).

_Alternative considered:_ change the raw port signature in one step. Rejected:
it touches seven sinks and every test stub at once, which makes it hard to
review and to bisect.

### D9. Project-runner-offline surfaces consistently

Thread creation and fork currently answer a pinned-runner outage with the generic
"No online runner found for this project". With `RunnerUnavailable` they return
the same `describeResolutionFailure` body (with `code`) as the proxy. The status
stays 502; only the message and the `code` field change.

### D10. Proofs do not expire

Runner ownership does not change during a request. Presence is re-checked by the
adapter at send time (it throws if the tunnel is gone), and scope is re-checked
on the runner → server data channel and by the runtime. A proof is only valid
inside its callback, which bounds its lifetime to a single operation.

## Risks / Trade-offs

- [`proxy.ts` is large and carries subtle header logic (Range, Host, Proto,
  binary bodies)] → Migrate it last, behind the existing proxy tests, and only
  replace header assembly for the identity fields; pass the rest through
  `UnsignedRunnerRequest.headers`.
- [Prover re-verification adds a DB lookup per request] → Reuse the
  `runner-scope` caches; ownership comes from presence (`userIdForRunner`, in
  memory) when available and from the DB otherwise.
- [Stripping identity headers could drop a header the runtime needs] → The strip
  list is exactly the set `signForwardedIdentity` produces plus `X-Runner-Auth`.
  A test asserts that a signed request verifies with `verifyForwardedIdentity`.
- [Scheduler `/dispatch` now refuses mismatches, which a misconfigured scheduler
  could hit] → Log and audit the refusal (`authz.cross_tenant_refused`) and return
  a non-retryable error so it is visible.
- [Fitness allow-list drift] → The final task asserts the allow-list is empty.

## Migration Plan

Server-only and wire-compatible; no data migration. Deploy the server alone.
Rollback is a revert of the server deploy; runners need no change.

## Implementation record

### Baseline (task 1.1)

- Working tree before this change: uncommitted `packages/client` edits (unrelated,
  left untouched) plus the uncommitted output of `add-thread-fork-authorization-proofs`
  (gdp-ts, `oxlint.config.ts`, `check-proof-lint.ts`, `type-tests/fork-ownership.ts`)
  and `modularize-thread-fork`, which this change builds on.
- Affected suites before any change (runner-isolation, proxy, fork, thread creation,
  browser socket, scheduler-system, project-runner-settings, resolver/scope, launcher,
  automation): `bun test --isolate …` → 333 pass, 0 fail (31 files).
- `bun run typecheck` → no new errors (baseline 116, current 1 pre-existing in `shared`).
- `bun run lint` → **fails before this change** at its first step: `oxlint .` reports
  `packages/client/src/components/settings/TeamMembers.tsx:338 react(purity)` (an
  `error`-level rule under the pilot's new `oxlint.config.ts`). Unrelated client code,
  not fixed here; the fitness steps of the `lint` chain were run individually.

### Characterization (task 1.2)

`__tests__/services/runner-sinks-characterization.test.ts` pins browser-session,
browser-PTY and `pty:list` (runner reached, identity signed, refusals + audit).
`project-runner-settings.test.ts` now also verifies the stop request is signed as the
project owner; `scheduler-system-routes.test.ts` already verified signing on
`/dispatch` and `/cancel`. Against the pre-migration code: 9/10 new cases passed. The
one red case, "another user's runner is never listed" for `pty:list`, documents the
gap this change closes: the legacy `pty:list` sink had no ownership check of its own
and trusted the `findAnyRunnerForUser` lookup. It passes after task 4.4.

### Design deltas discovered while implementing

- `RunnerTarget` has six kinds, not two. Besides `project`/`projectless`, the sinks
  needed `project-checkout` (terminals and browser sessions must land on the runner
  holding the files, no resolver fallback), `request` (route-based resolution for the
  proxy and scheduler dispatch), `runner` (certify a runner chosen elsewhere for a
  project) and `owned-runner` (ownership only). `owned-runner` exists because the two
  cleanup sinks — stop-sessions after a binding change and thread-delete cleanup —
  target a runner that has just LOST project scope; a project-scoped certification
  would refuse the very cleanup they perform. Spec requirement 2 is about selecting a
  runner to serve a project; cleanup is not serving.
- The prover's dependencies are injectable (`createRunnerAccess(deps)`) so socket and
  proxy tests run without a DB. Production uses the `runnerAccess` default; the fitness
  check restricts `createRunnerAccess(` to `services/runner-access/` (tests exempt).
- The threads module keeps its ports: the resolution adapters select + certify through
  `withRunnerFor` and return a plain runner id with a reason
  (`RunnerResolution = { ok, runnerId } | { ok: false, reason }`), and the remote
  adapters certify that id again (`{ kind: 'runner' }`) at send time so the proof is
  issued and consumed inside one callback. `RemoteThreadForkPort.fork` gained a
  trailing `projectId` for that certification.
- Resolution adapters call `runnerResolver.resolveRunnerDetailed` (for the reason), so
  route tests that mocked `resolveRunner` now mock `resolveRunnerDetailed`, and they
  seed `runner-1` / `__default__` rows + the project so certification has something to
  verify (D1: the prover re-checks `runners.user_id` and `runner-scope`).
- D9 applied: creation/fork `no-runner` now answers with `describeResolutionFailure`
  (`{ error, code }`); `threads-fork-isolation.test.ts` asserts
  `code: 'project-runner-offline'` for the pinned-offline case.
- Scheduler `/dispatch` with an unknown thread returns `404` (there is no owner to sign
  as); a mismatching `userId` returns `403` and audits `authz.cross_tenant_refused`.
- `AuthorizedRunnerRequests.sendOAuthCallback` sends only `X-Runner-Auth` (no role
  header); the legacy proxy also sent `X-Forwarded-Role: user` on that path. The runtime
  ignores identity on the OAuth callback.
- `ProxyTransport` is now `{ runnerAccess?, requests?, presence? }`; the proxy tests
  inject `createRunnerAccessMock()` / `fakeRunnerAccess()` instead of resolver fakes.
  The steer test additionally asserts the sharee identity + `steer` claim on the wire
  and that a sharee without a loaded thread gets 502 (no runner of their own).
- Browser handlers no longer receive `findAnyRunnerForUser` / `findRunnerForProject`;
  `getRunnerUserId` stays on `BrowserV1OperationDependencies` for RESOURCE ownership
  checks (not a send). The static guard `runner-isolation-routing.test.ts` now scans
  `services/runner-access/runner-for.ts`.

### 4.1–4.8 Sink migration

`scripts/fitness/check-runner-request-sinks.ts` started with 9 allow-listed files and
ends with an empty allow-list (`--self-test` ok). Migrated sinks: thread creation /
fork adapters and thread-delete cleanup (4.2), `browser-session` + `browser-v1-interactive`
(4.3), `browser-pty`, `browser-pty-list`, `browser-v1-operations` `pty:list` (4.4),
`project-runner-settings` stop-sessions (4.5), scheduler `/dispatch` + `/cancel` (4.6),
`middleware/proxy.ts` normal / delegated / OAuth paths (4.7). `sendDelegated` is
allowed only from `middleware/proxy.ts` and `createRunnerAccess` only from
`services/runner-access/` (4.8; self-test fixtures cover both).

### 6.1 Integration validation

```bash
bun scripts/fitness/check-runner-request-sinks.ts   # ok — allow-list empty
bun run fitness:runner-request-sinks:test            # self-test ok
bun run lint:proofs                                  # 19 fixtures ok (8 new)
bun run typecheck:proofs                             # ok (type-tests/runner-isolation.ts)
bun run typecheck                                    # ✓ No new typecheck errors (baseline 116, current 1)
bun run fitness:layering / module-boundaries / runner-transport / boundary-validation /
  query-validation / socket-validation / json-validation   # all ok
bunx oxlint packages/server scripts                  # 0 errors
cd packages/server && bun test --isolate             # 1156 pass, 1 skip (pre-existing), 0 fail (115 files)
```

`bun run lint` as a whole still exits 1 on the pre-existing `TeamMembers.tsx`
`react(purity)` error recorded in the baseline; every other step of the chain passes.
No suppressions were added and no baseline was refreshed.

### 6.2 Diff review

- Spec scenarios: own runner reached + signed (route, socket, scheduler and prover
  tests); another user's online runner never used (prover, fork-isolation,
  characterization, operations tests); terminal traffic certified (PTY tests);
  pinned project offline → `project-runner-offline`, no fallback (prover + fork
  isolation); projectless never reaches a dedicated runner (prover test); OAuth is
  the only userless route and its proof cannot satisfy `send` (type tests + prover);
  missing user rejected 401 before any runner is selected (proxy); scheduler
  dispatch signs the thread owner and refuses a mismatch; stop-sessions signs the
  project owner and skips a foreign runner.
- Wire format unchanged: every signed request in the tests verifies with
  `verifyForwardedIdentity` for the certified actor (and fails for anyone else).
- No change under `packages/runtime`, `packages/shared`, `packages/client-core` or
  `protocol/`; the pre-existing `packages/client` working-tree edits were not touched.
- No proof is serialized (`grep JSON.stringify(…proof…)` → none). Outside
  `services/runner-access`, `X-Forwarded-User` appears only in `middleware/auth.ts`,
  which READS inbound forwarded headers (not a sink).
- `services/runner-forwarding.ts` now exports only `runnerErrorMessage`;
  `buildForwardHeaders`, `fetchFromRunner` and `resolveRunnerForProject` are gone.
