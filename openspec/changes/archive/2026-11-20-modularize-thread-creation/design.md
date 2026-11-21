# Design

## Context

See proposal.md for motivation. The server's `createThreadOnRunner` serves both `POST /api/threads` and `POST /api/threads/idle`. It normalizes scratch payloads, selects a user-scoped runner, forwards signed identity, registers returned metadata, updates a routing cache, and maps results to HTTP. Runtime remains responsible for actual agent/worktree creation.

Existing `RunnerRequestPort` and `RunnerPresencePort` already isolate transport. The scheduler demonstrates dependency injection without a container. Reuse these conventions and existing Result-based service boundaries.

`codebase-simplification` remains active. Its task 8.4 concerns runtime creation helpers; this change owns server creation orchestration. Its completed repository registry can be reused. The archived thread-access spec predates steer delegation, so preserve current tested authorization and consult the active sharing changes rather than treating its older owner-only wording as authorization to remove sharing.

## Goals / Non-Goals

**Goals:**

- Make creation orchestration testable with in-memory port fakes, without Hono, a database, or a live runner.
- Keep normalized scratch and project creation targets distinct internally.
- Make the module boundary mechanically enforceable and the creation entry point easy to find.

**Non-Goals:**

- Migrating message/stop/share routes, runtime orchestration, client stores, or the shared `Thread` DTO.
- Tightening accepted inputs, changing authorization, introducing retries/transactions, or changing failure semantics.
- Full CQRS, event sourcing, a command bus, DI framework, generic repositories, or global value-object classes.

## Decisions

### D1. A feature module with inward dependencies

Use a small structure, adding files only for distinct responsibilities:

```text
server/src/modules/threads/
  index.ts                       application API/types
  domain/creation-target.ts      pure normalization and local value types
  application/create-thread.ts   orchestration
  application/ports.ts           required effects
  infrastructure/                adapters over existing services
  composition.ts                 production wiring

HTTP route -> use case -> domain + port interfaces
                           ^
                  production adapters
```

Routes perform HTTP parsing and response mapping and receive the composed use case. Production composition is the only place assembling concrete adapters. Domain and application code cannot import Hono, Drizzle, gRPC, server database modules, infrastructure, or concrete server services. Add a focused fitness check using existing repository tooling and wire it into lint. Other modules use the public API; bootstrap may use composition.

Alternative: move the existing helper into another service file. Rejected because its Hono context and concrete effects would remain coupled. A repository-wide folder migration is unnecessary to prove this boundary.

### D2. Model invariants without changing the public contract

Use an immutable `CreationTarget` discriminated union: scratch has no project and normalizes to local mode; project carries its project reference. Preserve optional project mode/default handling at the existing runtime boundary. Pure normalization returns Result and preserves existing error codes and evaluation order: a scratch payload with a non-null project fails before a conflicting mode, and both fail before runner I/O.

Use local branded `UserId`, `RunnerId`, and `ThreadId` for values received from existing trusted authentication/resolution/registration boundaries. These prevent accidental interchange; they do not prove authorization or replace runtime validation. Do not brand arbitrary request values using unchecked casts. Preserve the existing permissive request envelope and payload extensions; introducing stricter identifier formats is a separate behavior change. Keep any legacy boundary representation outside the normalized domain model.

This is selective value modeling, not a mandate to wrap every primitive. A full `Thread` entity or global identifier migration would expand the compatibility surface without helping this extraction.

### D3. Ports describe creation effects

The use case accepts a creation command with authenticated actor context, a normal/idle intent, and the existing payload envelope. It depends on small ports for resolving the actor's runner, creating remotely, registering metadata, and remembering thread routing. Actor identity always comes from authentication, never request body fields.

Adapters reuse current `resolveRunnerForProject`/`runnerResolver`, `RunnerRequestPort`, forwarded identity signing, `threadRegistry.registerThread`, and `cacheThreadRunner`. Signing secrets, header construction, runner URL selection, JSON transport, and database details remain in adapters. Extract shared helpers only when required; retain compatibility exports for existing consumers.

Preserve the sequence: normalize -> resolve -> remote create -> register when applicable -> cache -> return. No runner may be substituted from another user. A runner-side success followed by registry/cache failure retains current behavior; do not add a retry that could create duplicate threads.

Alternative: a generic repository interface exposing the whole database or a wrapper around the entire Hono handler. Both obscure the specific effects the use case needs.

### D4. Characterization defines compatibility

Before moving code, capture tests for both endpoints, scratch normalization and errors, project-required errors, user-scoped runner selection, unavailable runners, forwarded identity, payload extension preservation, runner error mapping, and successful response forwarding.

Also capture top-level `id` versus nested `thread.id`, runtime-generated branch precedence, the `__default__` runner's registration/cache bypass, missing response IDs, malformed runner JSON, and registry/cache failures. Preserve observed resolver-exception handling separately from exceptions inside the existing forwarding try/catch. Do not accidentally collapse distinct paths into one generic error result.

Unit tests verify rules and effect order using fakes. Route integration tests verify HTTP mapping and production wiring. Existing isolation, scratch, signed-identity, and sharing suites must remain green. At least one isolation test uses the real resolution adapter with two users and confirms an available foreign runner is never selected.

### D5. Keep query separation incremental

Creation is a command-side application use case. Existing list/detail queries remain unchanged and must not depend on the creation use case. This creates a useful boundary but is not a claim that full CQRS has been implemented. Separate read DTOs or projections only in a later change supported by actual query needs.

## Risks / Trade-offs

- [More indirection for a single flow] -> Keep ports narrow, compose with plain functions, and avoid one-class-per-operation scaffolding.
- [Behavior changes hidden by cleaner types] -> Characterize permissive inputs and error precedence first; keep wire DTOs unchanged.
- [Cross-user routing or identity regression] -> Reuse current adapters and run real adapter isolation tests, not only permissive mocks.
- [Concurrent simplification changes] -> Inspect current helper ownership before extraction; keep edits scoped to server creation and avoid modifying unrelated work.
- [Remote creation and registration remain non-atomic] -> Document the existing limitation; retry/idempotency design is outside this refactor.

## Migration Plan

1. Establish the current route behavior in tests and inventory shared helper consumers.
2. Introduce pure types/normalization and the use case behind fakes.
3. Wire adapters and switch both creation endpoints together, leaving other routes unchanged.
4. Run focused suites, `bun run lint`, and `bun run typecheck`; add the boundary check and update OpenWiki.
5. Review whether rules can be tested without infrastructure and whether routes have stopped coordinating persistence/runner effects. Expand to another flow only through a separate decision.

No data migration or coordinated runner release is required. Rollback reverts the module extraction and route wiring; wire contracts remain compatible.

## Implementation Notes

### Baseline inventory (task 1.1)

- `createThreadOnRunner` (`server/src/routes/threads.ts`) has exactly two consumers: `POST /api/threads` and `POST /api/threads/idle`. Nothing else imports it.
- Runner helpers that creation shares with other routes in `threads.ts`:
  - `resolveRunnerForProject`: used by creation, `POST /:id/fork`, `POST /:id/fork-and-rewind`.
  - `fetchFromRunner` and `runnerErrorMessage`: used by creation, fork, fork-and-rewind, and delete cleanup.
  - `buildForwardHeaders`: exported. Used by creation, fork, fork-and-rewind, and delete cleanup, and imported by `routes/project-runner-settings.ts`.
    These helpers move to `services/runner-forwarding.ts` so module adapters never import a route. `threads.ts` keeps re-exporting `buildForwardHeaders` so the existing import keeps compiling.
- `codebase-simplification` ownership: task 8.4 (`persistAndAnnounce` / `buildThreadRow`) covers **runtime** `thread-service/create`. It is untouched here. Task 4.4's lazy `db/repos.ts` is complete; the creation flow only writes through `thread-registry.registerThread`, which uses the `db` singleton directly, so the module needs no new repository wiring. Task 8.3 (`resultToResponse`/`parseOr400`) is pending and is not pre-empted. Creation keeps its own HTTP mapping.
- Unrelated working-tree changes (client sidebar/tool-card edits) are left untouched.
- Selected server test commands (run from `packages/server`):
  - `bun test src/__tests__/routes/threads-runner-proxy.test.ts src/__tests__/routes/threads-create.test.ts`
  - `bun test src/__tests__/modules/threads`
  - Regression suites: runner isolation, scratch, signed identity, and steer delegation (see task 4.2 results).

### Verification (tasks 4.2–4.3)

Run from `packages/server` on 2026-10-05:

- `bun test --isolate src/__tests__/routes/threads-create.test.ts src/__tests__/routes/threads-runner-proxy.test.ts src/__tests__/modules/threads src/__tests__/services/runner-isolation-routing.test.ts src/__tests__/services/scratch-thread-isolation.test.ts src/__tests__/middleware/proxy-forwarded-identity.test.ts src/__tests__/middleware/proxy-steer-delegation.test.ts src/__tests__/services/runner-resolver.test.ts src/__tests__/services/runner-resolver-project-binding.test.ts src/__tests__/services/runner-scope.test.ts src/__tests__/services/data-scope.test.ts src/__tests__/routes/thread-shares.test.ts src/__tests__/routes/project-runner-settings.test.ts`: 148 pass, 0 fail.
- Full server suite, `bun test --isolate`: 997 pass, 0 fail.
- The 33 characterization tests in `threads-create.test.ts` passed against the legacy handler before extraction and again, unchanged, after the routes were switched.
- `runner-isolation-routing.test.ts` statically asserts a user-scoped `findRunnerForProject(…, userId)` call. Its source list now points at `services/runner-forwarding.ts`, where `resolveRunnerForProject` moved. The assertion itself is unchanged.

From the repo root:

- `bun run lint`: passes, including the new `fitness:module-boundaries`. The existing oxlint warnings remain. `routes/threads.ts` still trips `max-lines` (808 > 800), but it was 911 at baseline, so the warning predates this change.
- `bun run typecheck`: no new errors. The single remaining error, in `packages/shared`, is in the baseline. The `@ts-expect-error` identifier-interchange checks in `creation-target.test.ts` compile, so the brands reject cross-assignment.

### Pilot findings (task 4.4)

- **HTTP contract unchanged.** The paths, status codes, error bodies and codes, the forwarded payload (including unknown fields), the forwarded identity headers, and the effect order (resolve → remote → register → cache) are all pinned by characterization tests that pass unchanged. Resolver exceptions still escape as 500, and every exception after remote creation is still `502 Thread creation failed`.
- **Testable without infrastructure.** `creation-target.test.ts` and `create-thread.test.ts` import only `domain/` and `application/` and run in about 30ms with in-memory fakes. Adapter tests use the real resolver and registry, including a two-user isolation check showing that an available foreign runner is never selected.
- **Routes free of creation orchestration.** `handleCreateThread` only parses the body, builds the authenticated actor, calls the composed use case, and maps the failure union to HTTP. Fork and fork-and-rewind still orchestrate inline and are candidates for a follow-up.
- **No schema or protocol changes.** There is no migration, no change to runner-protocol or the shared DTOs, and no new package. `services/runner-forwarding.ts` is a straight move of existing helpers. `routes/threads.ts` re-exports `buildForwardHeaders` for `project-runner-settings.ts`.
- **No unrelated edits.** The pre-existing client working-tree changes were left alone, and the runtime (`codebase-simplification` 8.4) was not touched.
- **Observations.** Ports plus per-request composition cost 8 small files for one flow. That is acceptable, but it argues against one file per operation. The brands add little at runtime, and their main value is in port signatures. Rolling the pattern out to fork, fork-and-rewind, or other flows should be a separate proposal.
