# Proposal

## Why

The browser ⇄ server HTTP API is mostly untyped: about 309 `request<T>(path)` calls in `packages/client/src/lib/api` take a `T` the server never checks. Only three groups (`automations`, `pipelines`, server-answered `threads`) are on the hand-built `@funny/shared/contracts` layer (`endpointGroup` / `serveEndpoint` / `callEndpoint`), and growing that layer means maintaining our own RPC framework. tRPC gives end-to-end inferred types, input validation with the zod schemas we already have, typed errors and a maintained client, so moving each group becomes a small, mechanical change.

This change covers only the HTTP API the browser calls. The server ⇄ runner gRPC channel (`runner.v2`) and the Socket.IO / `browser.v1` realtime transport do not change.

## What Changes

- Add a `@funny/api` workspace package with the tRPC router (`AppRouter`). Its procedures depend only on `@funny/shared` and on a ports interface the server implements, so the client can `import type { AppRouter }` without loading Bun-only server modules into its typecheck. This was the reason Hono RPC was rejected.
- Mount the router on the server at `/api/trpc/*` through Hono, after the existing CORS, CSRF, rate-limit and session middleware. Build the request context (user, organization, role) from the Hono context.
- Reuse the existing authorization rules (`requireThreadOwner` / thread-access decisions, scratch predicates) as tRPC middleware. Inaccessible resources still answer `404` before invalid input answers `400`.
- Map `DomainError` ⇄ `TRPCError` in both directions. On the client, a vanilla tRPC client uses a custom link that sends requests through the existing `request()` path, so auth, telemetry, the circuit breaker and `ClientPlatform` transport selection still apply, and calls still return `ResultAsync<T, DomainError>`.
- Start with a **pilot** that moves `automations` from contracts to tRPC, and set explicit go/no-go criteria: client typecheck isolation, bundle-size delta, typecheck time, all tests passing.
- After a go decision, move the other **server-answered** route groups one at a time (pipelines, threads read/update, projects, profile, settings, GitHub App settings, team, agent templates, watchers, jobs, designs, analytics, …). Remove `serveEndpoint` / `callEndpoint` / `endpointGroup` when the last contract group has moved.
- Keep the REST routes of a migrated group as long as any consumer outside the web client needs them (`packages/sdk`, `chrome-extension`, `plugin-sdk`, `client-gpuix`). Both the REST routes and the tRPC procedures call the same port implementation.
- Add fitness checks: `@funny/api` must not import `@funny/server`, `bun:*` or runtime-only modules, and migrated groups must not gain new `request<T>` calls in the client.

### Non-goals

- Replacing or changing gRPC between server and runner, the runner data channel, or `tunnel` frames.
- Replacing Socket.IO, `browser.v1` envelopes or realtime events with tRPC subscriptions.
- Moving runner-proxied routes (`/api/git/*`, files, browse, terminals, runner-answered thread actions) to tRPC. They keep going through `middleware/proxy.ts` and its runner-isolation proofs.
- Better Auth routes, public or unauthenticated routes (invite registration, LLM proxy, MCP OAuth callback), multipart uploads, media and raw-file URLs.

## Capabilities

### New Capabilities

- `browser-trpc-api`: typed tRPC procedures for the server-answered browser API. Covers router isolation from server internals, authentication and authorization semantics, error mapping, the client transport, and coexistence with REST during migration.

### Modified Capabilities

None. Client entity-sync, platform-services and browser-v1 requirements still hold; tRPC is one more typed operation path that satisfies them.

## Impact

- **New package:** `packages/api` (`@funny/api`).
- **New dependencies:** `@trpc/server` (server, `@funny/api`, and the client's link for `observable`) and `@trpc/client`.
- **Server:** `src/app.ts` (mount), new `src/trpc/` (context, ports implementation), and the route files of each migrated group.
- **Client:** `lib/api/_core.ts` (shared fetch path), new `lib/api/_trpc.ts`, `lib/api/*.ts` for migrated groups, and the data-layer loaders that call them.
- **Shared:** `contracts/*` schemas are reused as procedure inputs. The endpoint helpers are removed at the end.
- **Docs:** the CLAUDE.md "HTTP contracts" section and the openwiki development workflow.
- **Risk:** this is a large incremental migration. The pilot gate bounds it, and if the gate fails we keep extending contracts instead.
