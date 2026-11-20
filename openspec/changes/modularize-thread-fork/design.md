# Design

## Context

See proposal.md for motivation. `modularize-thread-creation` left `modules/threads/` with:

- a creation use case (`application/create-thread.ts`);
- narrow ports (`RunnerResolutionPort`, `RemoteThreadCreationPort`, `ThreadRegistryPort`, `ThreadRoutingCachePort`);
- adapters over `services/runner-forwarding.ts`, `runner-resolver`, and `thread-registry`;
- per-request composition (`composeCreateThread`);
- branded `UserId`/`RunnerId`/`ThreadId`;
- a fitness check (`check-module-boundaries.ts`) that enforces the layering.

`routes/threads.ts` still contains two handlers (`/:id/fork`, `/:id/fork-and-rewind`) that do the following inline, after `requireThreadOwner` has loaded the source thread:

1. `resolveRunnerForProject(source.projectId, userId, presence)`. This runs outside any try, so a resolver exception escapes as a 500. A `null` result returns `502 No online runner found for this project`.
2. Inside the try: build the signed headers, read the request body as raw text, and POST it unparsed to the same path on the runner.
3. A non-OK runner response is returned with the runner's status. The two variants format the error differently:
   - fork: `{ error: runnerErrorMessage(body) }`;
   - fork-and-rewind: `{ error: "Runner error: <raw body>" }`.
4. Parse the runner's JSON. The new thread is the top-level value for fork and `parsed.thread` for fork-and-rewind. A `null` body does not throw: it is returned as `201 null` and nothing is registered.
5. If the new thread has an id and the runner is not `__default__`, register it in the registry and then cache its routing:
   - `projectId` is `source.projectId`;
   - `title`, `model`, `mode`, and `branch ?? undefined` come from the runner's response;
   - `isScratch` is never set, so it is stored as false.
6. Return the runner's full body with status 201. Any exception inside the try (bad JSON, transport, registry, cache) is logged with `sourceThreadId` and mapped to `502 Thread fork failed` or `502 Thread fork-and-rewind failed`.

The server has tests for only four fork cases (`threads-runner-proxy.test.ts`) and none for fork-and-rewind.

## Goals / Non-Goals

**Goals:**

- One use case that covers both variants and can be tested with in-memory fakes.
- Each variant's differences live in exactly one place, not as two copied handlers.
- Reuse the registry and routing-cache ports and the `__default__` rule exactly as creation uses them.

**Non-Goals:**

- Normalizing the two error formats or the two response shapes. The client depends on both as they are.
- Changing how scratch forks are registered (see Open Questions).
- Validating the fork request body on the server. The runtime keeps its `forkThreadSchema` / `forkAndRewindSchema` validation.
- Touching `rewind`, delete cleanup, or any other proxied endpoint.

## Decisions

### D1. One use case, one variant parameter

Add `application/fork-thread.ts` exporting `makeForkThread(ports)`. Its command is:

- `actor`: the authenticated actor;
- `variant`: `'fork' | 'fork-and-rewind'`;
- `source`: `{ id: ThreadId, projectId }`, taken from the thread `requireThreadOwner` loaded;
- `body`: the raw request text.

The use case runs: resolve → remote fork → extract the new thread → register → cache → return. The only branch in it is the variant-specific response extraction (top-level vs `thread`).

Alternative: one file per endpoint. Rejected, because the pilot's findings already say one file per operation costs more than it gives, and the two flows differ in only three points.

### D2. Separate narrow ports for fork, reuse the persistence ports

`ForkThreadPorts` contains:

- `runners: SourceRunnerResolutionPort`. It has `resolve(actor, projectId)` and always goes through `resolveRunnerForProject`, scoped to the actor.
- `remote: RemoteThreadForkPort`. It has `fork(runnerId, actor, variant, sourceId, body)` and returns the existing `RemoteCreationResponse` shape: `ok` with the parsed body, or `status` + `message`.
- `registry` and `routingCache`: the existing ports.

Both new adapters go in the existing `infrastructure/runner-adapters.ts`. That file also holds the variant table: the runner path and the error formatter (`runnerErrorMessage` vs `Runner error: <body>`). These are transport details, so the use case never sees them.

Alternatives considered:

- Add `fork` to `RemoteThreadCreationPort` and a source method to `RunnerResolutionPort`. Rejected: every creation fake would then have to implement fork methods, and creation's port would stop describing creation.
- Reuse `RunnerResolutionPort` by mapping the source to a `CreationTarget`. Rejected: a scratch source would need either a project target with an empty project (which breaks the domain invariant) or the scratch resolution path (which changes which runner is chosen). Today fork always uses the project path, and this keeps that.

### D3. Failure union and HTTP mapping stay outside the module

`ForkThreadFailure` has three cases:

- `no-runner`;
- `remote-error { status, message }`;
- `fork-failed { cause }`.

Resolver exceptions propagate, as they do in creation. Everything from the remote call onward maps to `fork-failed`. The route maps:

- `no-runner` → 502 with the project message;
- `remote-error` → `{ error: message }` with the runner's status;
- `fork-failed` → log the error with `sourceThreadId`, then return a 502 with the variant's failure message.

The failure message and the log text stay in the route, next to the other HTTP strings.

### D4. Body read moves before resolution

The route reads `c.req.text()` before it calls the use case. Today the body is read after resolution, inside the try. The response only differs if reading the body throws, and it is a 502 either way:

- today: a resolution miss returns the no-runner message first, and a later read failure returns the fork-failed message;
- after this change: a read failure inside the route's guard returns the same fork-failed 502.

A lazy body thunk would keep the order exactly, but it would put a transport concern into the command. The difference is recorded here and is not otherwise observable.

### D5. Registration mirrors the legacy handler exactly

The registration fields come from the runner's response, not the request: `title`, `model`, `mode`, and `branch ?? undefined`. `projectId` is `source.projectId`. `isScratch` is set explicitly to `false`, with a comment pointing to the open question. That makes today's behavior visible instead of an implicit default.

### D6. Characterize first, then extract

Before the move, pin both endpoints in route tests:

- the success body for each variant, including `201 null`;
- the two non-OK error formats with the runner's status;
- the no-runner 502;
- malformed JSON → the variant's failure message;
- a registry failure after the runner succeeded (still 502, so it stays non-atomic);
- `__default__` skips registration and caching;
- a missing id skips registration;
- registration fields taken from the response;
- the raw body forwarded byte-for-byte;
- the signed actor headers;
- cross-tenant 404 from `requireThreadOwner`.

After the move, add:

- use-case tests with fakes (effect order, no I/O after no-runner, the extraction per variant);
- an adapter test where two users each have a runner available, and the one returned is always the actor's.

## Risks / Trade-offs

- **Risk:** the two error formats or response shapes get unified by accident. **Mitigation:** characterization tests pin each variant, and the variant table is the only place they differ.
- **Risk:** the read-order change in D4 is observable. **Mitigation:** both outcomes are 502 and only happen when body reading fails. The difference is recorded here, and it can be revisited if a test or bug shows it matters.
- **Risk:** more ports and indirection. **Mitigation:** two new interfaces in the existing `ports.ts` and two adapters in the existing file. The only new files are the use case and its test.
- **Risk:** the runner forks but registration fails, leaving the thread unregistered. **Mitigation:** none in this change. It is the existing behavior, the same limitation creation has. It stays documented and is not retried.

## Migration Plan

1. Add the characterization tests and confirm they pass against the inline handlers.
2. Add the ports, the use case, the adapters, and the composition, all behind fakes.
3. Switch both routes in one step. Confirm the characterization tests pass unchanged.
4. Run the focused suites, `bun run lint`, and `bun run typecheck`, then update OpenWiki.

No data migration and no runner release are needed. To roll back, revert the route wiring and the module additions.

## Open Questions

- **Should forking a scratch thread register the new thread as scratch?** Today it registers with `isScratch` false and with the source's (null) project, and runner resolution goes through the project path. Whether the client even offers fork on scratch threads, and whether the runtime forks scratch working directories correctly, should be checked separately. Any fix is a behavior change and belongs in its own change. This refactor only makes the current value explicit (D5).

## Implementation record

### 4.1 Test runs (from `packages/server`)

```bash
bun test --isolate \
  src/__tests__/routes/threads-runner-proxy.test.ts \
  src/__tests__/routes/threads-create.test.ts \
  src/__tests__/modules/threads \
  src/__tests__/services/runner-isolation-routing.test.ts \
  src/__tests__/services/scratch-thread-isolation.test.ts \
  src/__tests__/middleware/proxy-forwarded-identity.test.ts \
  src/__tests__/middleware/proxy-steer-delegation.test.ts \
  src/__tests__/services/runner-resolver.test.ts \
  src/__tests__/services/runner-resolver-project-binding.test.ts
# → 162 pass, 0 fail (12 files)

bun test --isolate
# → 1095 pass, 1 skip (pre-existing), 0 fail (111 files)
```

The characterization tests in `threads-runner-proxy.test.ts` (15 fork cases, 11 fork-and-rewind cases) were run and passed against the inline handlers before the extraction, and passed unchanged after the routes were switched. The module suites add `fork-thread.test.ts` (use case with fakes, both variants) and the fork blocks of `adapters.test.ts` (two-user isolation against the real resolver, both error formats, signed headers, raw body passthrough).

### 4.2 Lint and typecheck

```bash
bun run lint        # oxlint + fitness:layering + fitness:module-boundaries + runner-transport + boundary-validation checks → exit 0
bun run typecheck   # "No new typecheck errors (baseline: 116, current: 1)" → exit 0
```

- `fitness:module-boundaries` picked up `application/fork-thread.ts` automatically; no fixture changes were needed in `check-module-boundaries.ts`.
- The `check-json-boundary-validation` baseline count dropped (69 → 60); the two `JSON.parse` calls in the fork handlers now go through the adapter's `parseStoredJson`.
- Pre-existing, unrelated to this change: one typecheck error in `packages/shared` (in the fitness baseline), and oxlint `no-underscore-dangle` warnings on neverthrow's `_unsafeUnwrap*` helpers in the module tests (the new `fork-thread.test.ts` follows the same style as `create-thread.test.ts`).

### 4.3 Diff review

- **HTTP contracts unchanged per variant.** Pinned by the characterization tests: success bodies (fork top-level, fork-and-rewind full body, `201 null`), the `runnerErrorMessage` vs `Runner error: <raw body>` error formats with the runner's status, `502 No online runner found for this project`, `502 Thread fork failed` / `502 Thread fork-and-rewind failed`, byte-for-byte body forwarding, signed actor headers, cross-tenant 404, `__default__` bypass, missing-id skip, response-derived registration.
- **Routes no longer orchestrate fork.** Both endpoints call `handleForkThread(c, variant)`, which reads the body, builds the actor, runs `composeForkThread(c.env)`, and maps `no-runner` / `remote-error` / `fork-failed` to HTTP. The fork handler region contains no `threadRegistry`, `cacheThreadRunner`, `fetchFromRunner`, or `buildForwardHeaders` calls; the only remaining users of those services in `routes/threads.ts` are delete cleanup (out of scope). `resolveRunnerForProject` and `runnerErrorMessage` are no longer imported by the route.
- **No runtime, protocol, schema, or DTO changes.** `git diff --stat -- packages/runtime packages/shared packages/server/src/db scripts` is empty.
- **Unrelated working-tree changes untouched.** The pre-existing uncommitted `packages/client` edits were not modified.
- **One intentional implementation detail beyond D1–D6:** `domain/ids.ts` gained `authorizedThreadId(value)` to brand the source id loaded by `requireThreadOwner` (the existing `createdThreadId` documents a different provenance). The source id and project are taken from the loaded thread, not re-read from the URL param.
- **Behavior made explicit (D5):** `isScratch: false` is now written literally in `fork-thread.ts` with a comment pointing to the open question above. The registry stored `false` before as well (the field was omitted), so the persisted value is unchanged.
