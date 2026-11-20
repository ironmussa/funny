# Tasks

## 1. Foundation

- [x] 1.1 Add `trpc-to-openapi` and `zod-openapi` to `@funny/api` / server; confirm the `@funny/api` isolation fitness check still passes (allow-list the new import if it is browser-safe, else keep the OpenAPI handler server-side only)
- [x] 1.2 Create `@funny/shared/contracts/public-v1.ts` with the v1 input and output schemas (project, resolve result, thread creation input and result, model registry entries)
- [x] 1.3 Create the `publicV1` router in `@funny/api` (procedures with `meta.openapi` and output schemas, calling the existing ports); mount it with `createOpenApiFetchHandler` at `/api/v1` and serve `GET /api/v1/openapi.json`; verify the web router is not reachable under `/api/v1` and vice versa (done in the server: `public-api/`, see design D1)
- [x] 1.4 Fitness check: every public procedure has an output schema, lives under `/v1` and is on the allow-list; add its self-test (a test in `public-api.test.ts` walks every procedure of `publicV1Router`)

## 2. Personal API tokens

- [x] 2.1 Decide between Better Auth's API-key plugin and a `personal_access_tokens` table against design D4 (path scope, hashing, expiry, revocation, audit); record the decision in design.md
- [x] 2.2 Implement storage and the auth step for `/api/v1/*` only (refuse PATs elsewhere, refuse session cookies on `/api/v1/*`); rate limit per token; audit create / revoke / reject (`services/personal-access-tokens.ts`; `/api/v1` is mounted before the session middleware and never reads a session; a PAT elsewhere gets 401 from its own auth step)
- [x] 2.3 tRPC procedures + Settings UI to create (show once), list and revoke tokens (shadcn components, `data-testid`s, i18n en/es/pt)
- [x] 2.4 Tests: token authenticates v1, is refused on `/api/trpc/*` and runner-proxied routes, expired and revoked tokens are refused and audited

## 3. Endpoints

- [x] 3.1 `GET /api/v1/projects`, `GET /api/v1/projects/resolve`: tests for owned and shared projects, cross-user isolation, declared fields only
- [x] 3.2 `POST /api/v1/threads` on `startThreadOnRunner` / the threads creation use case: tests for creation on the caller's runner, offline runner (502, no fallback), inaccessible project (404), image size cap, permission-mode default
- [x] 3.3 `GET /api/v1/models` from the server's model registry
- [x] 3.4 Verify `bun run lint:proofs`, `typecheck:proofs` and `fitness:runner-request-sinks` still pass

## 4. Chrome extension

- [x] 4.1 Settings: server URL + API token; `chrome.permissions.request` for the configured origin; `optional_host_permissions` in `manifest.json`
- [x] 4.2 `background.ts` calls `/api/v1/*` with `Authorization: Bearer`; drop `/api/bootstrap` and `/api/setup/status`
- [ ] 4.3 Build the extension and test against a local server manually (document the steps) — steps documented in `packages/chrome-extension/README.md` ("Manual test"); the run in Chrome is still to do

## 5. Docs and follow-up

- [x] 5.1 Public API guide (`docs/guides/public-api.md`) pointing to `/api/v1/openapi.json`, with token setup and a `curl` example; update CLAUDE.md
- [ ] 5.2 After the extension release, open a follow-up change to remove the REST routes kept only for the extension
- [x] 5.3 Run `bun run lint`, `bun run typecheck`, the server, client and extension tests, and `openspec validate public-rest-api-v1 --strict`
