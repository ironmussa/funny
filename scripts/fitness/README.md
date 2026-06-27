# Architecture Fitness Functions

Automated checks that guard the architectural properties called out in `ARCHITECTURE_EVAL.md`. Run them in CI on every PR and locally with `bun run fitness`.

| Script                                | Enforces                                                                                                                                                                                                                                                                                                              |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `check-layering.ts`                   | `server` does not import `runtime`; `core` does not import `hono` or `drizzle-orm`; `shared` does not import `core` or `runtime`.                                                                                                                                                                                     |
| `check-circular.ts`                   | No file-level circular imports within `core/src`, `runtime/src`, `server/src`, `client/src`.                                                                                                                                                                                                                          |
| `check-file-size.ts`                  | No source file over 1500 lines, except files on the explicit waiver list (each with a decomposition target).                                                                                                                                                                                                          |
| `check-file-growth.ts`                | No file already over 1500 lines may grow by more than 100 net lines in a single PR. Compares HEAD against `origin/master` (or `$BASE_REF`).                                                                                                                                                                           |
| `check-boundary-validation.ts`        | No NEW unvalidated Hono `c.req.json()` request-body reads in `packages/server/src/routes` or `packages/runtime/src/routes`. Existing route debt is frozen in `.fitness/boundary-validation-baseline.txt`; new body reads must pass through a Zod validator such as `validate(schema, raw)` / `schema.safeParse(raw)`. |
| `check-query-boundary-validation.ts`  | No NEW typed Hono `c.req.query()` reads in route files without `parseQuery(c, schema)`. The check only targets number, boolean, enum/cast, and list coercions; plain string query reads are intentionally out of scope. Existing debt is frozen in `.fitness/query-boundary-validation-baseline.txt`.                 |
| `check-socket-boundary-validation.ts` | No NEW inbound Socket.IO payload handlers in server socket services or the runtime team client without a nearby Zod parse signal. Existing socket debt is frozen in `.fitness/socket-boundary-validation-baseline.txt`.                                                                                               |
| `check-json-boundary-validation.ts`   | No NEW direct `JSON.parse` calls in server/runtime/shared/core/orchestrator/memory source without explicit baseline refresh. New persisted or external JSON consumers should use `parseStoredJson` or `parseExternalPayload`.                                                                                         |
| `check-typecheck.ts`                  | No NEW `tsc --noEmit` errors vs the frozen baseline at `.fitness/typecheck-baseline.txt`. Pre-existing errors stay tracked but don't block commits. Refresh the baseline with `bun run typecheck:refresh`. Wired into the pre-commit hook for any commit that touches `.ts`/`.tsx`.                                   |

## Refreshing the typecheck baseline

When you fix a baseline error (or add a new file with intentional errors flagged for follow-up), refresh the baseline:

```bash
bun run typecheck:refresh
git add .fitness/typecheck-baseline.txt
```

Goal is for the baseline to shrink over time. PR reviewers should reject baseline growth without a stated reason.

## Refreshing the boundary validation baseline

When migrating route handlers to Zod validation, the baseline should shrink. If a new unvalidated body read is truly intentional temporary debt, refresh the boundary baseline:

```bash
bun run fitness:boundary-validation:refresh
git add .fitness/boundary-validation-baseline.txt
```

Prefer adding a Zod schema and validating the parsed body near the `c.req.json()` call. Accepted patterns are:

- `parseJsonBody(c, schema)` for new route code.
- `validate(schema, raw)` after assigning `raw = await c.req.json()`.
- `schema.safeParse(raw)` after assigning `raw = await c.req.json()`.

The body checker intentionally focuses on HTTP JSON request bodies. Query params, Socket.IO payloads, persisted JSON, and external provider responses are separate boundary checks.

The checker has fixture coverage for duplicate occurrences, accepted validation patterns, and new-debt detection:

```bash
bun run fitness:boundary-validation:test
```

## Refreshing the query validation baseline

Typed query parameters should use `parseQuery(c, schema)` with Zod coercion helpers where needed:

- Use `z.coerce.number()` for numeric query params.
- Use `queryBoolean` for booleans so `"false"` parses to `false`.
- Use `z.enum([...])` for enum-like query params.
- Use `queryList(schema)` for repeated or comma-separated list params.

When migrating typed query reads to `parseQuery`, the baseline should shrink. If a new typed query read is intentional temporary debt, refresh the query baseline:

```bash
bun run fitness:query-validation:refresh
git add .fitness/query-boundary-validation-baseline.txt
```

The checker has fixture coverage for string-read exemptions, numeric/boolean/enum/list detection, and new-debt detection:

```bash
bun run fitness:query-validation:test
```

## Refreshing the socket validation baseline

Inbound Socket.IO payloads should use a shared parser or schema at the socket boundary:

- Use `parseSocketPayload(schema, data)` or a specific `parse*` helper for direct `socket.on(...)` handlers.
- Use `registerSocketHandlersWithSchema(..., { payloadSchema })` for grouped fire-and-forget handlers.
- Use `registerSocketRpc(..., { payloadSchema })` for ack-based RPC handlers that consume payload data.

When migrating socket handlers to explicit payload schemas, refresh the socket baseline:

```bash
bun run fitness:socket-validation:refresh
git add .fitness/socket-boundary-validation-baseline.txt
```

The checker has fixture coverage for accepted parse helpers, RPC schemas, and new-debt detection:

```bash
bun run fitness:socket-validation:test
```

## Refreshing the JSON validation baseline

Persisted JSON and external payloads should be parsed with a Zod schema:

- Use `parseStoredJson(schema, raw, label)` for DB/storage/file JSON text.
- Use `parseExternalPayload(schema, value, source)` for already-decoded provider/API payloads.
- Keep one-off direct `JSON.parse` behind a narrowly scoped parser and tests, or refresh the baseline with a reason.

When migrating direct `JSON.parse` call sites, refresh the JSON baseline:

```bash
bun run fitness:json-validation:refresh
git add .fitness/json-boundary-validation-baseline.txt
```

The checker has fixture coverage for helper exemptions and new-debt detection:

```bash
bun run fitness:json-validation:test
```

## Adding a waiver

Edit `check-file-size.ts` and add an entry to `WAIVERS` with `{ current, target, note }`. The PR description MUST link to a decomposition plan. Waivers are expected to shrink — `target < current` is the norm.

## CI wiring

Add to your PR workflow:

```yaml
- run: bun run fitness
```

Or individual checks:

```yaml
- run: bun run fitness:layering
- run: bun run fitness:size
- run: bun run fitness:circular
- run: BASE_REF=origin/${{ github.base_ref }} bun run fitness:growth
```
