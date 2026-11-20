# Proposal

## Why

`modularize-thread-creation` moved thread creation into `packages/server/src/modules/threads/`, but `POST /api/threads/:id/fork` and `POST /api/threads/:id/fork-and-rewind` still repeat the same sequence inline in `routes/threads.ts`: resolve the runner, forward the signed identity, make the remote call, register the thread, and cache its routing. That copied sequence is the last thread-orchestration code left in the route file, and the two copies already differ in small ways that nothing tests. Moving them behind the module's existing ports completes the pilot for the threads module before the pattern is applied anywhere else.

## What Changes

- Add a fork use case to `modules/threads/application/` that covers both the `fork` and `fork-and-rewind` variants. It reuses the existing runner resolution, registry, and routing-cache ports and the `__default__` bypass.
- Add the smallest remote port extension needed to fork on the runner (a variant-aware fork call over the existing signed forwarding helpers), instead of one new port or file per endpoint.
- Make both route handlers thin: they read the source thread loaded by `requireThreadOwner`, build the authenticated actor, call the composed use case, and map the failure union to HTTP.
- Before any extraction, pin today's behavior with characterization tests, including the differences between the two variants:
  - error-body format: `runnerErrorMessage` for fork, raw `Runner error: <body>` for fork-and-rewind;
  - where the new thread sits in the response: top-level for fork, `thread` nested for fork-and-rewind;
  - failure messages: `Thread fork failed` vs `Thread fork-and-rewind failed`;
  - forwarding the request body unparsed;
  - registration fields taken from the runner's response;
  - the `__default__` bypass;
  - no fallback to another user's runner.
- Extend the module-boundaries fitness fixtures only if the new files need it.

## Capabilities

### New Capabilities

None. This is an internal refactor with no new externally observable behavior.

### Modified Capabilities

None. HTTP paths, request and response bodies, status codes, error messages, effect ordering, and runner isolation stay the same. `.openspec.yaml` sets `skip_specs: true`. As in `modularize-thread-creation`, tests characterize existing behavior instead of adding artificial requirements.

## Impact

- **Code:** `packages/server/src/routes/threads.ts` (fork and fork-and-rewind handlers), `packages/server/src/modules/threads/` (application, infrastructure, composition, public index), server route and module tests, and possibly `scripts/fitness/check-module-boundaries.ts` fixtures.
- **No changes to:** the runtime (`packages/runtime` fork/rewind services), the runner protocol, shared DTOs, the database schema, or deployment.
- **Depends on** `modularize-thread-creation` (implemented, not yet archived) and reuses its ports, brands, and composition.
- **Out of scope:** the `data-handler.ts` registry (`codebase-simplification` task 8.1), delete cleanup, `rewind` and the other proxied endpoints, and fixing the existing behavior where forking a scratch thread registers the new thread with `isScratch` false. That last item is recorded as an open question in design.md.
