# Design

## Context

`@funny/api` holds the tRPC router the web client calls (`adopt-trpc-browser-api`). Procedures call server ports; the REST routes of each group delegated to the same ports and are being removed where nothing calls them. External clients, the Chrome extension first, need a stable REST surface. `trpc-to-openapi` 3.5.0 (checked 2026-11-12: peers `@trpc/server ^11.1`, `zod ^4`, `zod-openapi ^5.4`) maps tRPC procedures to REST paths from `meta.openapi` and generates an OpenAPI 3 document.

Its constraints shape the design:

- An exposed procedure **must** have a zod `output` parser.
- GET and DELETE inputs come from the query string and path. Fields must be string, number, bigint, date or boolean, and are converted strictly.
- POST, PATCH and PUT inputs are the whole JSON body, merged with path parameters.
- Errors are derived from `TRPCError` codes, in the library's error body, not our REST `{ error }` shape.
- Auth comes from `createContext`. `protect: true` documents a Bearer security scheme.

## Decisions

### D1. Separate v1 procedures and paths; do not reshape the web client's procedures

The web client's procedures use inputs like `{ projectId, data }` that make poor REST bodies. The v1 endpoints are their own procedures in a `publicV1` router, mounted only by the OpenAPI handler at `/api/v1`. They call the **same ports** as the web procedures. The web router is unchanged and never mounted under `/api/v1`, and the v1 router is never mounted under `/api/trpc`.

_Alternative rejected:_ add `meta.openapi` to the existing procedures. That would freeze the web client's input shapes as a public contract and expose `/api/trpc` semantics to tokens.

**Placement (2026-11-12):** the `publicV1` router lives in the server (`packages/server/src/public-api/`), with its own tRPC instance typed with `OpenApiMeta`, not in `@funny/api`. `trpc-to-openapi` pulls node modules (`h3`, `co-body`) that the `@funny/api` isolation rule forbids, and nothing needs the router's types in a browser: external clients use the REST paths and the OpenAPI document. It is mounted before the session middleware, so `/api/v1` never sees a session and every request under it is answered there, never by the runner proxy.

### D2. Output schemas are the public contract

Each v1 procedure declares a zod output schema, so responses are validated and documented. The schemas live in `@funny/shared/contracts/public-v1.ts`, and are browser-safe so the extension can reuse them. Output validation strips undeclared fields: a v1 response never leaks a field nobody decided to publish (for example, internal paths on another member's project).

### D3. Thread creation on the server

`POST /api/v1/threads` calls the `modules/threads` creation use case through `runner-thread-launcher.ts` (`startThreadOnRunner`), which automations already use. It must choose the runner through `withRunnerFor` for the token's user and send through `AuthorizedRunnerRequests`. There is no new sink and no fallback runner (runner isolation rules). The input schema is explicit: `projectId`, `prompt`, optional `title`, `images` (base64 PNG/JPEG with a size cap), `mode` (`local` | `worktree`), `provider`, `model`, `permissionMode` (a safe default, never `bypassPermissions` unless the project allows it), and `source` fixed to `api` or `chrome_extension`.

### D4. Personal API tokens

- Format `funny_pat_<random>`. Stored as a SHA-256 hash with prefix, name, owner, created, last used, expiry (default 90 days, max 1 year) and revoked flag. The plaintext is shown once.
- Authentication: a step in `middleware/auth.ts` before `sessionStep` that applies only to `/api/v1/*`. A PAT on any other path is refused with 401, never treated as a session, and `/api/v1/*` refuses session cookies, so CSRF does not apply. It sets the same context (`userId`, role, org) as a session.
- **Decision (2026-11-12): a `personal_access_tokens` table, not Better Auth's API-key plugin.** The plugin is now a separate package (`@better-auth/api-key` 1.7.22) that requires `better-auth ^1.7.22`; we run 1.7.7, so adopting it means upgrading the auth library for the whole app first. It also does not scope a key to a path: with `enableSessionForAPIKeys` a key becomes a full session, so we would verify keys ourselves in the `/api/v1` step anyway. And it brings its own table, while our schema is created by `db/migrate.ts` (raw SQL, SQLite and Postgres), so we would hand-write its DDL regardless. A small table gives the same hashing / expiry / revocation with path scope and our own audit records built in: `id`, `user_id`, `name`, `prefix` (first 8 chars, shown in the list), `token_hash` (SHA-256 of the full token), `created_at`, `last_used_at`, `expires_at`, `revoked_at`. Verification is one indexed lookup by hash plus a constant-time compare.
- Rate limit per token. Audit records: `pat.created`, `pat.revoked`, `pat.rejected` (expired, revoked or unknown).

### D5. Errors

Map `ApiFailure` statuses to `TRPCError` codes as the web router does (`toTrpcError`). The v1 error body is whatever `trpc-to-openapi` produces (`{ message, code, issues? }`), documented in `openapi.json`. It is not our legacy `{ error }` shape, and that is acceptable because v1 has no legacy consumers.

### D6. Chrome extension migration

- Settings gain _Server URL_ and _API token_.
- `background.ts` calls `/api/v1/*` with `Authorization: Bearer`, and drops `/api/bootstrap` and `/api/setup/status`, using `/api/v1/models`.
- `manifest.json` keeps localhost as `host_permissions`, adds `optional_host_permissions: ["https://*/*", "http://*/*"]`, and calls `chrome.permissions.request` for the configured origin.

## Risks / Trade-offs

- **Public contract cost:** every v1 change is now a compatibility decision. This is mitigated by the minimal surface and the version prefix.
- **Token leakage** from an extension's storage: tokens are scoped to v1 (create threads, read project names), expire, and are revocable. They never reach runner-proxied routes.
- **Library risk:** `trpc-to-openapi` is a community fork, though active. It is isolated behind the `publicV1` router and one mount, so it can be replaced by hand-written Hono routes over the same ports.
- **Thread creation semantics:** the same use case as `POST /api/threads` keeps behaviour identical, but the v1 input is stricter.

## Migration

1. Ship v1 and tokens, with the old routes untouched.
2. Release the extension using v1.
3. A later change removes `GET /api/bootstrap`'s legacy role for the extension and the REST routes kept only for it (`GET /api/projects/resolve`, …), after checking callers again.
