## Context

The codebase already uses Zod in several places:

- Runtime route schemas live in `packages/runtime/src/validation/schemas.ts`.
- Pipeline YAML parsing validates with `pipelineSchema.safeParse`.
- Socket payload helpers exist in `packages/shared/src/socket-events.ts`.
- `eslint-plugin-zod` now enforces schema hygiene for schemas that already exist.

The gap is coverage. Some route handlers still read `c.req.json()` and cast the result, or manually inspect fields, without a Zod parse at the HTTP boundary. Similar gaps exist for query parameters, Socket.IO payloads, persisted JSON, config/env input, and external provider responses. A blanket rule like "use Zod everywhere" would be noisy because internal TypeScript narrowing is still appropriate for trusted values.

This change treats runtime validation as an architectural boundary policy: untrusted data must be parsed once at ingress, then the rest of the system uses typed values.

```text
Untrusted input
  ├─ HTTP body/query
  ├─ Socket payload
  ├─ YAML/config/env
  ├─ persisted JSON
  └─ external API response
        │
        ▼
   Zod boundary parse
        │
        ▼
   typed internal value
```

## Goals / Non-Goals

**Goals:**

- Define the trust-boundary categories where Zod validation is required.
- Provide recognizable Zod-backed helper APIs for each boundary family.
- Prevent new unvalidated HTTP JSON body reads immediately.
- Migrate existing route debt incrementally with a shrinking baseline.
- Expand enforcement in separate phases so each boundary type has targeted, low-noise checks.
- Preserve `eslint-plugin-zod` as schema-quality enforcement.

**Non-Goals:**

- Do not require Zod for ordinary internal functions or trusted in-memory values.
- Do not rewrite every existing route in one step.
- Do not replace domain-level validation such as filesystem containment, authorization, or business-rule checks.
- Do not collapse all boundary types into one broad lint rule.
- Do not treat manual checks as sufficient for untrusted structured payloads unless they are explicitly wrapped in a boundary parser.

## Decisions

### Decision 1: Validate boundaries, not all code

Boundary validation applies only where data crosses from an untrusted or weakly typed source into application logic:

- HTTP JSON bodies.
- HTTP query params when coercion or non-string structure is needed.
- Socket.IO and WebSocket payloads.
- YAML/config/env/CLI input.
- Persisted JSON read back from DB/storage.
- External API/provider responses used structurally.

Internal type guards and domain checks remain valid inside already-typed code. This keeps enforcement practical and avoids false positives in normal TypeScript control flow.

**Alternative considered:** enforce every `typeof`/`Array.isArray`/manual field check through lint. Rejected because it would flag legitimate internal narrowing and create review noise.

### Decision 2: Use helper APIs as the mechanical signal

Each boundary family should have a small parsing helper that returns a typed value or a domain-friendly error. Examples:

- `parseJsonBody(c, schema)` for Hono JSON bodies.
- `parseQuery(c, schema)` for Hono query params.
- `parseStoredJson(schema, raw, label)` for DB/storage JSON blobs.
- `parseExternalPayload(schema, raw, source)` for provider/API responses.
- `parseSocketPayload(schema, raw, eventName)` for socket events.

The exact package placement can vary by boundary:

- Runtime-only helpers can stay in `packages/runtime/src/validation` or route utilities.
- Server-only helpers can live under `packages/server/src/lib` or `packages/server/src/validation`.
- Shared helper types can live in `@funny/shared` only if both server and runtime need the same contract.

**Rationale:** helpers make validation easy to review, easy to grep, and easy for baseline checks to recognize. Direct `schema.safeParse(raw)` remains acceptable when a helper would add no value.

### Decision 3: Baseline-backed fitness checks gate new debt

Existing unvalidated boundary reads should be frozen into a baseline so checks can run green immediately. The baseline is not approval that the current code is ideal; it is a work queue. Each migration should remove entries from the baseline.

The first implemented check targets Hono `c.req.json()` reads in:

- `packages/server/src/routes`
- `packages/runtime/src/routes`

New route body reads must validate near the body read with `validate(schema, raw)`, `schema.safeParse(raw)`, or a recognized parse helper. Future checks should use the same baseline-diff model for other boundary families.

**Alternative considered:** fail the build on all current unvalidated bodies. Rejected because the route backlog is broad and would make the check unusable until a large migration completes.

### Decision 4: One enforcement surface per phase

The migration should proceed in phases:

1. HTTP JSON bodies.
2. HTTP query params requiring coercion or structure.
3. Socket.IO/WebSocket payloads.
4. Persisted JSON from DB/storage.
5. YAML/config/env/CLI parsing.
6. External API/provider responses.

Each phase gets:

- A boundary policy.
- Helper APIs or accepted direct-parse pattern.
- A baseline if existing debt is present.
- A migration task that shrinks the baseline.
- Tests for the helper/checker behavior where practical.

**Rationale:** each boundary has different false-positive risks. Separate checks keep enforcement understandable and reversible.

### Decision 5: Zod schema linting remains schema hygiene

`eslint-plugin-zod` should continue to catch risky schema patterns such as `z.any()` and redundant `.optional().default(...)`. It does not decide whether a boundary should have a schema. The custom fitness checks handle coverage; the plugin handles quality.

## Risks / Trade-offs

- **Heuristic false positives in fitness checks** -> Keep checks narrowly scoped, baseline-backed, and documented. Prefer helper APIs as explicit signals.
- **False negatives from custom validation wrappers** -> Register accepted helper names in the checker and keep wrappers small.
- **Baseline drift becomes normalized debt** -> Require baseline growth to be justified. Prefer shrinking the baseline when touching a route family.
- **Duplicate server/runtime helper implementations** -> Start local to each package to avoid coupling, then extract to shared only when duplication stabilizes.
- **Over-validating already trusted internal values** -> Keep the policy boundary-only and document non-goals clearly.

## Migration Plan

1. Keep the existing HTTP JSON body checker wired into `bun run lint`.
2. Add a first-class `parseJsonBody` helper for runtime/server route handlers.
3. Migrate route families from the baseline one at a time, starting with small files before high-churn routes.
4. Refresh the boundary baseline only when entries are intentionally removed or explicitly accepted as temporary debt.
5. Add the next boundary check only after the previous phase is stable.
6. Continue using `bun run lint` and `bun run typecheck` as the required verification gate.

Rollback is straightforward for each phase: remove the fitness-check script from `bun run lint` or restore the previous baseline. No data migration is involved.

## Open Questions

- Should the common route parsing helper live in each package first, or should a shared helper be introduced immediately?
- Should query param enforcement cover every `c.req.query()` read, or only reads converted to number/boolean/list/object?
- Should persisted JSON parsing be enforced in shared repositories first, or in runtime/server services that consume repository output?
- How strict should the checker be about validation distance from `c.req.json()` when route handlers have complex setup code?
