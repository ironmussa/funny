# Tasks

## 1. Pin current fork behavior

- [x] 1.1 Extend `packages/server/src/__tests__/routes/threads-runner-proxy.test.ts` with fork characterization cases:
  - success body forwarded verbatim, including `201 null`;
  - non-OK runner response → `{ error: runnerErrorMessage(body) }` with the runner's status;
  - no-runner 502;
  - malformed JSON → `502 Thread fork failed`;
  - registry failure after the runner succeeded → 502;
  - `__default__` skips registration and caching;
  - a missing id skips registration;
  - registration fields taken from the runner's response, with `projectId` from the source and `isScratch` false;
  - raw body forwarded byte-for-byte;
  - signed actor headers.

  Verify they pass against the current inline handler.

- [x] 1.2 Add the same characterization set for `POST /:id/fork-and-rewind`, covering its differences:
  - nested `thread` extraction;
  - full `parsed` body returned;
  - `Runner error: <raw body>` error format;
  - `502 Thread fork-and-rewind failed`.

  Include a cross-tenant 404 case. Verify all pass against the current inline handler.

## 2. Add the fork use case to the threads module

- [x] 2.1 Add `SourceRunnerResolutionPort`, `RemoteThreadForkPort`, `ForkVariant`, `ForkThreadCommand`, and `ForkThreadPorts` to `modules/threads/application/ports.ts`. Reuse `ThreadRegistryPort`, `ThreadRoutingCachePort`, and `RemoteCreationResponse`. Verify that `bunx tsc --noEmit -p packages/server` passes and the creation fakes compile unchanged.
- [x] 2.2 Implement `application/fork-thread.ts` (`makeForkThread`, `ForkThreadFailure`, `ForkThreadSuccess`) following design D1, D3, and D5. Verify `__tests__/modules/threads/fork-thread.test.ts` covers, with fakes, for both variants:
  - effect order (resolve → fork → register → cache);
  - no remote call after a no-runner result;
  - resolver exceptions propagating;
  - post-remote exceptions mapped to `fork-failed`;
  - top-level vs nested extraction;
  - the `null` body;
  - the `__default__` bypass;
  - a missing id;
  - registration fields from the response.
- [x] 2.3 Implement the source-resolution and remote-fork adapters in `infrastructure/runner-adapters.ts`, with a variant table for the runner path and error formatter. Add `composeForkThread(env)` to `composition.ts` and export the new API from `index.ts`. Update the module docs in `index.ts`:
  - fork is now an entry point;
  - its invariants: actor-scoped source resolution, response-derived registration, explicit `isScratch: false`.

  Verify `__tests__/modules/threads/adapters.test.ts` covers:
  - the two-user isolation case (only the actor's runner is returned, even when another user's runner is available);
  - both error formats;
  - the signed headers;
  - raw body passthrough.

## 3. Wire the routes

- [x] 3.1 Replace both inline handlers in `routes/threads.ts` with a shared thin adapter. It:
  - reads the raw body under a guard that maps a read failure to the variant's failure message (design D4);
  - builds the actor;
  - calls the composed use case;
  - maps the failure union to HTTP, logging `fork-failed` with `sourceThreadId`.

  Verify the characterization tests from group 1 pass unchanged, and `rg "threadRegistry|cacheThreadRunner" packages/server/src/routes/threads.ts` no longer matches in the fork handlers.

- [x] 3.2 Update the OpenWiki thread-domain and architecture pages so fork and fork-and-rewind appear as module use cases alongside creation. Verify the links resolve, and that no page claims full CQRS or a repository-wide migration.

## 4. Integration checks

- [x] 4.1 Run from `packages/server`:
  - the affected route, module, and adapter suites;
  - the runner-isolation, scratch-isolation, signed-identity (`proxy-forwarded-identity`), steer-delegation, and runner-resolver suites;
  - the full `bun test --isolate`.

  Record the commands and results in design.md.

- [x] 4.2 Run `bun run lint` (including `fitness:module-boundaries`, which picks up the new file automatically) and `bun run typecheck`. Resolve any regressions this change introduced, and record any failure that existed before this change explicitly in design.md.
- [x] 4.3 Review the final diff and record the findings in design.md:
  - HTTP contracts unchanged per variant;
  - the routes no longer orchestrate fork;
  - no runtime, protocol, schema, or DTO changes;
  - unrelated working-tree changes untouched.
