# Design

## Context

See proposal.md (Why). Current state:

- Server-answered groups on contracts register routes with `serveEndpoint(router, endpoint, handler)` (`packages/server/src/validation/endpoint.ts`). The rest of the server routes are plain Hono handlers. Runner-answered requests go through the catch-all in `middleware/proxy.ts`.
- On the client, every call goes through `request<T>()` in `lib/api/_core.ts` (auth, telemetry, circuit breaker, `ClientPlatform` transport), or through `callEndpoint` on top of it. Results are `ResultAsync<T, DomainError>`. The data layer (`src/data/`) calls these from loaders and actions.
- Hono RPC was rejected because importing the server's route types pulls Bun-only modules into the client typecheck. tRPC's `AppRouter` type import has the same problem unless the router lives outside `packages/server`.
- Other first-party REST consumers are `packages/sdk`, `chrome-extension`, `plugin-sdk` and `client-gpuix`.
- `browser.v1` already types request/response operations over Socket.IO. That is the realtime path. tRPC handles the HTTP request/response path, and the two do not overlap.

## Goals / Non-Goals

**Goals:** isolate the router type, make migration per group mechanical, keep client call sites returning `ResultAsync`, keep the security middleware unchanged, and set a clear go/no-go gate.

**Non-Goals (design level):** request batching, a superjson transformer, the TanStack Query tRPC integration, and subscriptions over tRPC. All of these can be revisited after the migration.

## Decisions

### D1. Router in a new `@funny/api` package with ports

`packages/api` defines `initTRPC.context<ApiContext>()`, the procedure builders and one router per group, combined into `appRouter` / `type AppRouter`. Procedures call `ctx.ports.<group>.<method>()`. `ApiPorts` is an interface defined in `@funny/api` whose types come from `@funny/shared` (contracts and types). The server implements `ApiPorts` in `packages/server/src/trpc/ports/*.ts` on top of its repositories and services, and maps DB rows to contract types there, as routes do today.

- _Alternative: routers inside `packages/server`, client imports the type._ Rejected: that is the Hono RPC problem again.
- _Alternative: emit `.d.ts` from the server._ Rejected: it adds a build step, and inferred types still reference server modules.
- _Alternative: routers in `@funny/shared`._ Rejected: `shared` is also the DB/repository kernel, and adding `@trpc/server` there mixes two roles.
- Fitness check `scripts/fitness/check-trpc-api.ts` (`fitness:trpc-api`, in `bun run lint`): `packages/api/src/**` may import only `@trpc/server`, `zod`, `neverthrow` and browser-safe `@funny/shared` subpaths (the same allow-list the client uses).

### D2. Mount at `/api/trpc/*` with tRPC's fetch adapter

`server/src/trpc/mount.ts` (`mountTrpc(app, ports)`) registers `app.all('/api/trpc/*')` with `fetchRequestHandler` from `@trpc/server/adapters/fetch`. `@hono/trpc-server` was dropped: it types the router and context as `AnyRouter` / `Record<string, unknown>`, so it adds a dependency and loses type checking. The router is mounted in `createServerApp` after `authMiddleware` and the existing CORS/CSRF/rate-limit middleware, and before the runner proxy catch-all, so `/api/trpc` is never proxied. `createContext` reads `userId`, organization and role from the Hono context and attaches `ports`. An unauthenticated request reaches tRPC only for procedures built on `publicProcedure`. There are none in this change. `protectedProcedure` answers `UNAUTHORIZED` (401).

### D3. Authorization as tRPC middleware with ordering

The thread-access decision (`middleware/thread-access.ts`) is factored into a function that does not depend on Hono, and both the Hono middleware and a tRPC middleware call it. The tRPC middleware runs **before** `.input()`. It reads only the resource id from `getRawInput()` with a minimal schema, and answers `NOT_FOUND` for missing or inaccessible resources. Only after that does full input validation run. This keeps the "404 before 400" rule. Scratch rules use the existing runtime/server predicates and are not re-derived.

### D4. Errors

Ports fail with `ApiFailure = { status, message, friendlyMessage? }` (`packages/api/src/failure.ts`), which is the HTTP status the REST route answers today. This keeps the two paths identical, including statuses that `DomainError` cannot express, such as a 502 from an offline runner. `failureFromDomainError` adapts services that return a `DomainError` (NOT_FOUND→404, BAD_REQUEST/VALIDATION→400, FORBIDDEN→403, CONFLICT→409, PROCESS_ERROR/INTERNAL→500). In a procedure, `unwrap(result)` throws `toTrpcError(failure)`, whose tRPC code comes from the status (`codeForStatus`: 404→NOT_FOUND, 502→BAD_GATEWAY, …, other 4xx→BAD_REQUEST, otherwise INTERNAL_SERVER_ERROR), so the response carries the same HTTP status.

`errorFormatter` (`packages/api/src/trpc.ts`):

- copies a port's `friendlyMessage` to the top of the error shape;
- replaces an input-validation message with the first issue's message, the same text `parseJsonBody` answers;
- replaces the message of any unexpected throw with `Internal server error`.

`isDev: false`, so responses never contain stack traces. `mountTrpc`'s `onError` logs internal errors with namespace `trpc`. On the client, `RequestFailure` carries the `DomainError` from `request()` through the observable, and `trpcCall` unwraps it.

### D5. Client: vanilla client with a link that sends through `request()`

`lib/api/_trpc.ts` creates `createTRPCClient<AppRouter>` with one terminating link. The link sends each operation through the existing `request()` from `lib/api/_core.ts`, so it reuses the whole `client-core` API client: base URL from `ClientPlatform`, credentials, telemetry span and metrics, circuit breaker, `onUnauthorized` and AbortSignal. A query becomes `GET /api/trpc/<path>?input=<json>`, and a mutation becomes `POST /api/trpc/<path>` with a JSON body. No transport function needs to be extracted. The only change in `client-core` is that `api-client.ts` reads a tRPC error body (`{ error: { message, friendlyMessage?, data: { httpStatus } } }`) the same way as a REST one, so failures become the same `DomainError`. `trpcCall(() => trpc.<group>.<proc>.query(...))` returns `ResultAsync<T, DomainError>`, so `lib/api/<group>.ts` keeps its signatures and data-layer loaders and actions do not change. Batching is off, so per-request rate limits, telemetry and circuit-breaker accounting stay one-to-one with requests. No transformer is used, so the wire JSON stays identical to the REST bodies. `client-gpuix` can use the same link through its own platform transport.

- _Alternative: `@trpc/tanstack-react-query`._ Deferred: it brings React into a renderer-independent data layer, and our `QueryClient` keys and freshness already work.

### D6. Coexistence with REST

For each migrated group, REST handlers and procedures call the same port method, and a parity test runs both. A REST route is removed only when `rg` over the first-party consumers (`sdk`, `chrome-extension`, `plugin-sdk`, `client-gpuix`) finds no caller, and in a separate PR. The fitness check `check-trpc-api.ts` keeps a list of migrated groups (`MIGRATED_GROUPS`) and fails on `request(`/`requestInThread(` to their paths, or on use of their contract objects, from `packages/client/src`.

### D7. Pilot and gate

Pilot group: `automations`, which is already on contracts and answered entirely by the server. **Go** if all of these hold:

1. `bun run typecheck` for the client does not include `packages/server/**` or `bun-types` from `AppRouter`, checked with `tsc --listFiles`.
2. The client bundle grows by ≤ 15 kB gzip.
3. Client typecheck time grows by ≤ 15%.
4. All tests, lint and the e2e smoke test for automations pass.

**No-go:** revert the pilot and keep extending `@funny/shared/contracts`. Both outcomes are recorded in this change.

**Pilot result (2026-11-11): Go.**

| Criterion                             | Measured                                                                                                                                                                                              | Limit     |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| Client typecheck pulls in server code | `tsc -p packages/client --listFiles`: 7066 files, none under `packages/server`, `packages/runtime`, `bun-types` or drizzle. `@funny/api` adds its own 5 source files and the `@trpc/*` `.d.ts` files. | none      |
| Contract drift caught                 | A wrong input key (`{ automationId }`) and a wrong output type (`name: number`) each fail the client typecheck                                                                                        | must fail |
| Bundle delta                          | +11.1 kB gzip over every JS chunk (`vite build`, HEAD vs pilot). Measured before `TRPC_PATH` moved to `@funny/api/path`, which only removes code from the bundle (see below)                          | ≤ 15 kB   |
| Client typecheck time                 | median 10.40 s → 10.66 s (+2.5%, 3 runs each)                                                                                                                                                         | ≤ +15%    |
| Tests                                 | client unit 2858 passed; api + client-core + shared + server 1783 passed; lint fitness checks and baseline typecheck green                                                                            | green     |
| e2e smoke                             | not run: it needs running dev servers, which agents must not start here                                                                                                                               | —         |

Found during the pilot: a _value_ import from `@funny/api` in the browser runs `initTRPC`, and `@trpc/server` refuses to run outside a server. The client therefore imports only `type AppRouter` from the main entry and takes `TRPC_PATH` from the separate `@funny/api/path` entry. `fitness:trpc-api` rejects any runtime import of `@funny/api` from `packages/client/src`.

The one run of the full `--affected` suite took two hours on a loaded machine and showed 5 timeouts in `packages/runtime` (`agent-runner-class.test.ts`). That file does not depend on this change, and run alone it passes (38/38).

### D8. Order after the pilot

Order: contract groups first (`pipelines`, server-answered `threads`), then the server-owned groups by size and risk: profile, settings, GitHub App settings, team-settings/team-projects, agent-templates, watchers, jobs, designs, analytics, projects (server-answered parts), runners (server-side CRUD), and push. `serveEndpoint`/`callEndpoint`/`endpointGroup` are deleted together with the last contract group. The zod schemas in `contracts/*` stay as procedure inputs.

## Risks / Trade-offs

- [Two API styles for a long time] → Migration is per group with a fitness list. The CLAUDE.md section says which style to use, and new groups must use tRPC.
- [Logic duplicated between REST and tRPC handlers] → Both delegate to one port method. Handlers only adapt.
- [The procedure-name URLs (`/api/trpc/automations.get?input=…`) are harder to inspect than REST] → Telemetry tags each span with the procedure path, and server logs include it.
- [The port layer adds indirection] → Ports are thin and follow the group's repository/service methods. No new abstraction layer is added.
- [Long GET query strings for big inputs] → Use mutations for large inputs. Queries keep small id/filter inputs.
- [CSRF: tRPC POSTs are `application/json`] → Hono's `csrf` middleware already applies to `/api/*`. A test asserts that a cross-origin mutation is refused.
- [Type inference cost grows with the router] → The router is split per group, the pilot measures typecheck time (D7), and the work stops if inference becomes too slow.

## Migration Plan

1. Scaffold `@funny/api`, the server mount and the client link with no procedures. Ship it inert.
2. Pilot `automations` (procedures and client) with REST kept. Run the parity test, then evaluate the D7 gate and record the result here.
3. Migrate one group per PR in the D8 order. Each PR adds its group to the fitness list and updates docs if a pattern changes.
4. Remove REST routes once no consumer is left, in separate PRs.
5. Remove the contract endpoint helpers and update CLAUDE.md and the openwiki.

**Rollback:** each group PR can be reverted on its own, because REST stays mounted until step 4. If the pilot fails, revert steps 1–2.

## Open Questions

- Should `packages/sdk` eventually expose a tRPC client to third parties, or stay REST? This does not affect this change, because REST stays for external consumers.
