## 1. Foundation

- [x] 1.1 Add Zod schema hygiene rules through Oxlint/`eslint-plugin-zod`.
- [x] 1.2 Add a baseline-backed HTTP JSON body boundary check for Hono route files.
- [x] 1.3 Wire the HTTP body boundary check into `bun run lint`.
- [x] 1.4 Document the initial boundary validation fitness check and baseline refresh flow.
- [x] 1.5 Add focused tests or fixture coverage for the boundary validation checker, including duplicate occurrences, accepted validation calls, and new unvalidated reads.

## 2. Helper APIs

- [x] 2.1 Add a runtime `parseJsonBody` helper that reads `c.req.json()`, applies a Zod schema, and returns a typed result or route-friendly validation error.
- [x] 2.2 Add a server-side equivalent or shared helper if the runtime helper shape works for both packages.
- [x] 2.3 Update the boundary checker to recognize the final helper name(s) and direct `schema.safeParse(raw)` / `validate(schema, raw)` patterns.
- [x] 2.4 Document accepted boundary parsing patterns in the fitness README.

## 3. HTTP Body Migration

- [x] 3.1 Migrate small runtime route files from `.fitness/boundary-validation-baseline.txt` to `parseJsonBody` or direct Zod validation.
- [x] 3.2 Migrate small server route files from `.fitness/boundary-validation-baseline.txt` to `parseJsonBody` or direct Zod validation.
- [x] 3.3 Migrate high-churn route families (`threads`, `pipelines`, GitHub PR routes) in separate focused commits.
- [x] 3.4 Refresh `.fitness/boundary-validation-baseline.txt` after each migration slice and verify the violation count only shrinks unless explicitly justified.

## 4. Query Param Enforcement

- [x] 4.1 Define a `parseQuery` helper for Hono query params that supports string, number, boolean, enum, and list coercion through Zod.
- [x] 4.2 Identify query-param reads that perform numeric, boolean, enum, or list coercion and create an initial query baseline if needed.
- [x] 4.3 Add a targeted query-param boundary fitness check without flagging plain string reads unnecessarily.
- [x] 4.4 Migrate representative query-heavy routes and shrink the query baseline.

## 5. Socket Payload Enforcement

- [x] 5.1 Inventory Socket.IO/WebSocket inbound payload handlers in server, runtime, and shared socket utilities.
- [x] 5.2 Standardize socket payload parsing with existing shared schemas or new per-event Zod schemas.
- [x] 5.3 Add a socket-specific boundary fitness check or test coverage that rejects unvalidated new inbound socket payload handlers.
- [x] 5.4 Migrate socket handler debt incrementally and track any baseline separately from HTTP route baselines.

## 6. Persisted JSON, Config, and External Responses

- [x] 6.1 Inventory `JSON.parse` call sites that read persisted DB/storage blobs or external response bodies.
- [x] 6.2 Add `parseStoredJson` and/or `parseExternalPayload` helpers for structurally consumed JSON.
- [x] 6.3 Add targeted checks or tests for new unvalidated persisted/external JSON consumption.
- [x] 6.4 Confirm YAML/config/env/CLI parsing paths already have Zod schemas or add missing schemas with focused tests.

## 7. Verification

- [x] 7.1 Run `bun run lint` after each phase and confirm no new boundary validation debt is introduced.
- [x] 7.2 Run `bun run typecheck` after helper or schema changes.
- [x] 7.3 Add or update behavior tests for migrated routes where validation behavior changes user-visible errors.
- [x] 7.4 Confirm `eslint-plugin-zod` remains limited to schema hygiene and does not enforce broad architectural policy.
