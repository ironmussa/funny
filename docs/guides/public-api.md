# Public REST API (v1)

The public API lets scripts and tools outside the web app — the Chrome extension, a CI job, your own scripts — list your projects and start threads in funny. It is versioned under `/api/v1` and described by an OpenAPI 3 document, so you can browse it in any OpenAPI viewer or generate a client from it:

```
GET /api/v1/openapi.json
```

## Authentication: personal API tokens

Every endpoint except the OpenAPI document needs a **personal API token**:

1. In funny, open **Settings > API tokens**.
2. Give the token a name (what will use it, e.g. "CI deploy") and an expiry: 30, 90 (default) or 365 days.
3. Copy the token (`funny_pat_…`). It is shown **once**; if you lose it, revoke it and create a new one.

Send it on every request:

```
Authorization: Bearer funny_pat_…
```

What a token can and cannot do:

- It acts as **you**: it sees your projects and the ones shared with you, and starts threads on **your own runner**. It never reaches another user's runner.
- It works **only under `/api/v1`**. Anywhere else (the web app, `/api/trpc`, the runner-proxied routes) it is refused with `401`, and it cannot sign in to the web app.
- Revoke it any time in **Settings > API tokens**; revoked and expired tokens are refused with `401`. Every refusal is audited.
- Each token owner may make **120 requests a minute** (plus a per-IP limit); over it, `429` with `Retry-After`.

## Endpoints

| Method | Path                            | What it does                                               |
| ------ | ------------------------------- | ---------------------------------------------------------- |
| `GET`  | `/api/v1/projects`              | Your projects and the ones shared with you                 |
| `GET`  | `/api/v1/projects/resolve?url=` | The first of your projects whose URL patterns match a page |
| `POST` | `/api/v1/threads`               | Create a thread and start it on your runner                |
| `GET`  | `/api/v1/models`                | The providers and models the server offers                 |

Responses carry only the published fields (`openapi.json` is the reference). For example, a project never includes its path on a runner's disk.

### Create a thread

```bash
curl -X POST "https://funny.example.com/api/v1/threads" \
  -H "Authorization: Bearer $FUNNY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "projectId": "PROJECT_ID",
    "prompt": "Fix the failing login test",
    "title": "Login test",
    "mode": "worktree"
  }'
```

```json
{
  "thread": {
    "id": "…",
    "projectId": "PROJECT_ID",
    "title": "Login test",
    "status": "…",
    "createdAt": "…"
  }
}
```

The body:

| Field               | Required | Notes                                                                                                                                                                                                   |
| ------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `projectId`         | yes      | A project you can work in (`GET /api/v1/projects`)                                                                                                                                                      |
| `prompt`            | yes      | Up to 100,000 characters                                                                                                                                                                                |
| `title`             | no       | Up to 200 characters                                                                                                                                                                                    |
| `mode`              | no       | `local` (default) or `worktree`                                                                                                                                                                         |
| `provider`, `model` | no       | Must exist in `GET /api/v1/models`                                                                                                                                                                      |
| `permissionMode`    | no       | `ask` (default), `confirmEdit` or `plan`. Modes that approve tool calls on their own (`autoEdit`, `auto`, `bypassPermissions`) are refused: a token can start work, not grant it unattended permissions |
| `images`            | no       | Up to 4, each `{ "mediaType": "image/png" \| "image/jpeg" \| "image/webp", "data": "<base64>" }`, at most 5 MB decoded                                                                                  |
| `client`            | no       | `chrome_extension` marks threads created by the extension; without it the thread is recorded as created through the `api`                                                                               |

## Errors

Errors are JSON `{ "message": "…", "code": "…" }` (validation errors add `issues`):

| Status | When                                                                    |
| ------ | ----------------------------------------------------------------------- |
| `400`  | The body or query does not match the schema                             |
| `401`  | No token, or a malformed, unknown, revoked or expired one               |
| `403`  | You can see the project but not start threads in it                     |
| `404`  | The project does not exist or is not yours to see; any unpublished path |
| `413`  | The request body is too large                                           |
| `429`  | Rate limit; retry after the `Retry-After` seconds                       |
| `502`  | Your runner is offline or not connected — connect it and retry          |

## For the Chrome extension

Open the extension's **Options**, enter the server URL and paste a token, then **Save & test connection**. For a server other than `localhost`, Chrome asks for permission to reach that origin. See `packages/chrome-extension/README.md`.
