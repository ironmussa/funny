## Why

Today every thread carries a fixed `(provider, model)` chosen by hand in the UI. Users either over-pay by running everything on a frontier model (`DEFAULT_MODEL = 'opus-4.8'`) or under-power complex tasks by picking something cheap. Competitors (e.g. Factory Router) now select the model per task automatically and cut 20-25% of token spend while keeping frontier-level quality. funny already has the raw signals to do the same — a code-graph for fan-out, diffs, context-window metadata, and an autonomous loop with retry/escalation state — but no layer that turns those signals into a model choice.

## What Changes

- Add a new sentinel model value **`'auto'`** to `AgentModel`. When a thread's model is `'auto'`, the runner resolves a concrete `(provider, model)` at spawn time instead of using a fixed value.
- Introduce a **pure routing layer** in `packages/core` that maps cheap, non-LLM task features to a model **tier** (`light | mid | frontier`) and then to a concrete model from the existing registry.
- Resolve the route **in the runner just before `startAgent`** (`agent-runner` / `agent-lifecycle`), where code-graph, diff, and cwd signals are available. No server-side or UI routing decision in v1.
- Ship a pure, tested `escalateTier()` primitive so a later version can drive escalation-by-result, but do **not** wire escalation into any run in v1 (see below).
- Extend `ModelDefinition` in `packages/shared/src/models.ts` with routing metadata (`tier`, `relCost`, optional `strengths`) so the registry stays the single source of truth.
- Log every routing decision (features in, model out, outcome) as **telemetry** to tune thresholds later.
- **Out of scope for v1 (deferred to v2):**
  - The LLM "gatekeeper" classifier (e.g. Gemma 4 12B / Haiku) for ambiguous tasks. The architecture leaves a seam for it but v1 is heuristic-only.
  - **Full escalation-by-result.** The retry counters (`ciAttempts`, `reviewAttempts`, `escalated`) live in `packages/agent` (`@funny/orchestrator`), a separate engine the runtime does not import — a v1 `'auto'` thread spawned via the runner never enters that `Session` loop, so there is no path to escalate. A mid-session model swap would also invalidate the provider prompt cache. v2 chooses the escalation home and weighs cache cost vs. gain.

## Capabilities

### New Capabilities

- `model-routing`: Automatic, per-task selection of `(provider, model)` from cheap task features, behind an `'auto'` model value, with decision telemetry. Ships the `escalateTier()` primitive; full escalation-by-result is deferred to v2.

### Modified Capabilities

<!-- None — no existing spec-level behavior changes; fixed-model selection remains the default and is unaffected. -->

## Impact

- **`packages/shared/src/models.ts`** — `ModelDefinition` gains `tier`/`relCost`/`strengths`; `AgentModel` gains `'auto'`; new helpers to list models by tier.
- **`packages/core/src/routing/` (new)** — pure `router.ts` (`extractFeatures`, `route`) returning `neverthrow` `Result` (required in `core`).
- **`packages/runtime/src/services/agent-runner.ts` / agent-lifecycle** — resolve `'auto'` → concrete model before `startAgent`; emit telemetry.
- **`packages/agent/src/core/session.ts`** — no change in v1. (v2 escalation would hook here, re-routing one tier up on retry.)
- **Validation** — `agentModelSchema` (`packages/runtime/src/validation/schemas.ts`) must accept `'auto'`.
- **Client** — `'auto'` becomes a selectable option in the model picker (label + i18n key); no other UI change required.
- **No breaking changes** — fixed-model threads behave exactly as before; `'auto'` is purely additive.
