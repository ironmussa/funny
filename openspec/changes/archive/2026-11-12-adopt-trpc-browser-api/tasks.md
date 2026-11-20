# Tasks

## 1. Scaffold (inert)

- [x] 1.1 Create `packages/api` (`@funny/api`) with `initTRPC.context<ApiContext>()`, `publicProcedure` / `protectedProcedure`, `appRouter` and `type AppRouter`; add `@trpc/server` / `@trpc/client` to the right packages (`@hono/trpc-server` dropped, see D2); add `packages/api/tsconfig.json` to `check-typecheck.ts`; verify `bun install` and `bun run typecheck` pass
- [x] 1.2 Add `scripts/fitness/check-trpc-api.ts` (only `@trpc/server`, `zod`, `neverthrow`, browser-safe `@funny/shared` subpaths allowed in `packages/api/src`) and wire it into `bun run lint`; verify with a fixture import of `@funny/server` that lint fails, then remove the fixture
- [x] 1.3 Implement `errorFormatter` + `unwrap()` (DomainError → TRPCError: NOT_FOUND 404, BAD_REQUEST/VALIDATION 400, FORBIDDEN 403, CONFLICT 409, PROCESS_ERROR/INTERNAL 500, sanitized messages); verify with unit tests in `packages/api`
- [x] 1.4 Mount the router at `/api/trpc/*` in `packages/server/src/app.ts` after auth/CSRF/rate-limit and before the proxy catch-all; build `createContext` from the Hono context + `ApiPorts`; verify with server tests: 401 without session, cross-origin mutation refused, `/api/trpc` never reaches the runner proxy
- [x] 1.5 Reuse `request()` as the link's transport (no extraction needed, see D5) and teach `client-core/src/api-client.ts` to read a tRPC error body like a REST one; verify `client-core` api-client tests (new tRPC-body and non-tRPC-object cases) pass
- [x] 1.6 Add `packages/client/src/lib/api/_trpc.ts` (vanilla client, terminating link over `request()`, no batching, no transformer) and a `trpcCall()` helper returning `ResultAsync<T, DomainError>` with `TRPCClientError` → `DomainError`; verify with client unit tests for error mapping, circuit-breaker fail-fast, and abort

## 2. Pilot: automations

- [x] 2.1 Factor the automations route logic into an `AutomationsPort` implementation in `packages/server/src/trpc/ports/automations.ts`, and make the existing REST handlers delegate to it; verify the existing automation route tests still pass
- [x] 2.2 Add the `automations` router in `@funny/api` (queries: list, get, runs; mutations: create, update, delete, trigger, …) using the existing `contracts/automations.ts` zod schemas as inputs; verify with server procedure tests (validation 400, owner isolation 404, happy paths)
- [x] 2.3 Add a REST↔procedure parity test for automations (same user, same data → same response); verify it passes
- [x] 2.4 Switch `packages/client/src/lib/api/automations.ts` to `trpcCall()` keeping its public signatures; verify client tests (`api-trpc.test.ts`, `api.test.ts`) and data-layer automation tests pass (the Playwright e2e smoke needs running dev servers and was not run here)
- [x] 2.5 Add `automations` to the migrated-groups list in the client fitness check (no `request(` / `callEndpoint(` to `/automations` from `packages/client/src`); verify lint fails on a fixture call and passes without it
- [x] 2.6 Evaluate the D7 gate (client `tsc --listFiles` has no `packages/server/**` / `bun-types`; bundle delta ≤ 15 kB gzip; client typecheck time ≤ +15%; lint/typecheck/tests green) and record numbers + Go/No-go in `design.md`; on No-go revert groups 1–2 and close this change

## 3. Thread-access middleware for procedures

- [x] 3.1 Extract the thread-access decision from `packages/server/src/middleware/thread-access.ts` into a Hono-free function used by both the Hono middleware and a new tRPC middleware that reads the id via `getRawInput()` before `.input()`; verify existing thread-access tests pass and new procedure tests assert 404 for another user's thread and 404-before-400 on invalid input

## 4. Migrate the remaining contract groups

- [x] 4.1 Migrate `pipelines` CRUD and run history (port, router, parity test, client switch, fitness list entry with `restOnly: ['/approvals']`; approval gates stay REST because the server may proxy them to a runner); verify pipeline server/client tests and parity test pass
- [x] 4.2 Migrate the server-answered `threads` routes (lists, detail, messages and search, field updates and the pipeline DSL's status/stage; creation and fork stay REST because the runner answers them) using the 3.1 middleware; the client's `callEndpoint` (`lib/api/_contract.ts`) is removed since no group calls contracts over REST any more; verify thread route tests, scratch-thread restrictions tests, data-layer thread tests and parity test pass
- [x] 4.3 Update CLAUDE.md "HTTP contracts" section and the openwiki development workflow to describe tRPC as the pattern for server-answered groups (and REST + proxy for runner-answered); verify the documented steps match the pilot code

## 5. Migrate server-owned groups (one PR each)

- [x] 5.1 Migrate `profile` and `settings` (adds `adminProcedure` and `projectProcedure`, sharing `requireAdmin`'s audit and `requireProjectAccess`'s decision; `settings/github-app` stays REST until 5.2); verify their route tests, parity tests and client settings tests pass
- [x] 5.2 Migrate `settings/github-app`; verify `github-app-settings` server test and `GithubAppSettings` client test pass
- [x] 5.3 Migrate `team-settings` and `team-projects` — not applicable: no first-party consumer calls them (the six `teamApi` functions for them have no callers in the client, SDK or gpuix), so there is nothing to type; the REST routes stay as they are
- [x] 5.4 Migrate `agent-templates`, `watchers` and the `jobs` list (job cancel / log stay REST, proxied to the runner; adds `resourceProcedure` for 404 / 403 before validation; template `null` columns become absent fields on both paths); verify tests and parity pass
- [x] 5.5 Migrate `designs` (rows; the design folder on disk stays REST, proxied to the runner), `analytics` (response types now shared and declared by the service) and `push` (the endpoint check and subscription schema move to `contracts/push`); verify tests and parity pass
- [x] 5.6 Migrate the server-answered parts of `projects` and `runners` (CRUD, runner settings), leaving runner-proxied endpoints on REST; verify project/runner route tests, runner-scope tests and parity pass, and that `check-runner-request-sinks.ts` still passes
  - [x] projects: list, resolve, update, delete, reorder, members, local path, startup command CRUD (`projects-trpc.test.ts`; creation and the runner's routes stay REST)
  - [x] runners and project runner settings: list, remove, assignment, enrollment lookup / approval, the project's runner binding and the general runner (`runners-trpc.test.ts`; what a runner calls with its own credential stays REST, and the runner-scope writers and `withRunnerFor` stop path are unchanged)

## 6. Retire REST duplicates and contract helpers

- [x] 6.1 For each migrated group, check `packages/sdk`, `chrome-extension`, `plugin-sdk` and `client-gpuix` for callers; remove REST routes with no callers in separate PRs; verify those packages' tests/typecheck pass
  - Callers found: the Chrome extension (`GET /api/projects`, `/projects/resolve`), client-gpuix (thread reads, `GET /profile`), the e2e fixtures and soak script (`PUT /profile`, `DELETE /projects/:id`, `GET`/`PATCH /threads`); those stay REST. Everything else was removed in three commits (automations + pipelines; settings, templates, watchers, `GET /jobs`, designs, analytics, push; projects, runners, project runner settings, archived threads); removed paths answer 404 on the server (`routes/retired-rest.ts`, `REMOVED_PROJECT_ROUTES`, `refuseUser`). The e2e mocks moved to the tRPC procedures. The public API for external senders is a separate change, `public-rest-api-v1`. Later, the server-answered thread routes (list, scratch, detail, messages, message and content search, field updates, permission mode, status, stage) were removed too: client-gpuix and the e2e fixtures now call the `threads.*` procedures over HTTP, and the REST paths answer 404 (`REMOVED_THREAD_ROUTES`).
- [x] 6.2 Delete `serveEndpoint` / `callEndpoint` / `endpointGroup` once no contract group remains (keep the zod schemas); verify `fallow dead-code` reports nothing new and `bun run lint && bun run typecheck` pass

## 7. Integration

- [x] 7.1 Run `bun run lint`, `bun run typecheck`, the full test suite and the client build; confirm the client bundle contains no server modules and `openspec validate adopt-trpc-browser-api --strict` passes
  - 2026-11-12: oxlint (packages, scripts, e2e) 0 errors; every fitness step and lint:proofs / typecheck:proofs pass; typecheck of 16 projects clean (pre-commit); server suite 167 files / 1,827 tests green; client unit tests green (two timeouts under load pass alone); client build passes and its bundle has no server code (only an icon named drizzle-orm). Known, not from this change: the Storybook browser stories ReviewPane, PromptInputUI, InlineDiff, AskQuestionCard and ExitPlanModeCard fail on master too (`useThread* hooks require a <ThreadProvider> ancestor`: their decorators lack a ThreadProvider). `openspec validate --strict` passes.
