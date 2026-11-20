# Proposal

## Why

Funny has clients outside the web app that send work in from elsewhere, above all the Chrome extension, which annotates a page and creates a thread from it. They talk to an informal REST API that was never designed as one:

- The extension authenticates with a token from `GET /api/bootstrap`, which no longer returns one. It sends no `Authorization` header and depends on Chrome attaching the session cookie to a cross-origin request, which a default `fetch` does not do. It most likely gets `401` today.
- Its `manifest.json` only allows `localhost:3001`, so it cannot reach a deployed server.
- Its key call, `POST /api/threads`, is a runner-proxied route whose body shape is defined nowhere, and `GET /api/setup/status` is answered by the user's runner.
- The REST routes the web client used are being removed as their groups move to tRPC (`adopt-trpc-browser-api`), so external consumers have no stable surface to build on.

A small, versioned, documented public API, generated from the same tRPC procedures the web client calls, fixes all of these at once: one implementation, typed inputs and outputs, an OpenAPI document, and real token authentication.

## What Changes

- Expose a chosen set of `@funny/api` procedures as REST under `/api/v1/*` with [`trpc-to-openapi`](https://www.npmjs.com/package/trpc-to-openapi) (3.x: tRPC 11, zod 4, fetch adapter). Each exposed procedure declares `meta.openapi` (method, path, summary, tags) and a zod **output** schema. Serve the generated document at `GET /api/v1/openapi.json`.
- **v1 surface (minimal):**
  - `GET /api/v1/projects`: the caller's projects (owned and shared), `projects.list`.
  - `GET /api/v1/projects/resolve?url=`: the project whose URL patterns match a page, `projects.resolve`.
  - `POST /api/v1/threads`: create a thread with a prompt, optional title, images, mode, provider, model and permission mode, and start it on the caller's runner. This is a new server-side `threads.create` procedure on the `modules/threads` creation use case, the one `POST /api/threads` and automations already use. It goes through the runner-isolation sink like every other server → runner request.
  - `GET /api/v1/models`: the providers and models the server's registry offers. This is the server's view; whether the runner has a CLI installed stays a runner concern.
- **Personal API tokens.** A user creates, lists and revokes tokens in Settings. A token is shown once, stored hashed, expires, and is scoped: it authenticates `/api/v1/*` only, never the web app's session routes, `/api/trpc/*`, or runner-proxied routes. Requests carry `Authorization: Bearer <token>`.
- **Chrome extension:** migrate to `/api/v1` and the personal token: a token field in settings instead of `/api/bootstrap`. Make the server URL's host permission optional (`optional_host_permissions`, requested when the user sets a server URL).
- Keep the REST routes the extension uses today (`GET /api/projects`, `GET /api/projects/resolve`, `POST /api/threads`, `GET /api/setup/status`, `GET /api/bootstrap`) until the extension release that uses v1 has shipped. Remove them in a separate, later change.
- Fitness check: every procedure with `meta.openapi` has an output schema and is under `/v1`, and nothing outside the allow-list is exposed.

### Non-goals

- Exposing every tRPC procedure as REST. v1 is the smallest surface external senders need, and it grows only by explicit decision.
- Replacing the web client's tRPC transport, or exposing `/api/trpc/*` to tokens.
- Runner-answered operations (git, files, terminals, agent control beyond creating a thread) on the public API.
- Changing the Ingest API (`POST /api/ingest/webhook`, `X-Webhook-Secret`), which serves agents streaming into a thread, a different use.
- OAuth app authorization flows for third parties. Tokens are personal.

## Impact

- New dependencies in `@funny/api` / server: `trpc-to-openapi`, `zod-openapi` (peer).
- `@funny/api` procedures in the v1 set gain output schemas (`Project`, `ResolveProjectResponse`, created `Thread`, model registry entries). Their inferred client types stay the same.
- New table (or Better Auth API-key plugin storage) for personal tokens; Settings UI section; audit records for create, revoke and use-after-revoke.
- `packages/chrome-extension`: background auth, settings UI, manifest permissions.
- Docs: a public API guide generated from, or linked to, `openapi.json`.
