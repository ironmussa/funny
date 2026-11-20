## Context

Model selection in funny is static. The single source of truth is `MODEL_REGISTRY` in `packages/shared/src/models.ts`, which exposes `ModelDefinition { id, label, contextWindow, i18nKey }` plus `resolveModelId(provider, model)`, `getDefaultModel`, `getProviderModels`, and `getModelContextWindow`. A `Thread` carries fixed `provider: AgentProvider` and `model: AgentModel`; the runner passes `model` into `agent-runner.startAgent(threadId, prompt, cwd, model?, …)` at `packages/runtime/src/services/agent-runner.ts:63`. `DEFAULT_MODEL = 'opus-4.8'`.

Two facts make per-task routing cheap to add:

1. There is already an autonomous loop in `packages/agent` whose `Session` (`packages/agent/src/core/session.ts`) tracks `plan.estimated_complexity`, `ciAttempts`, `reviewAttempts`, and an `escalated` state — i.e. the retry/escalation machinery exists.
2. The runner has access at spawn time to live signals grep cannot give: code-graph fan-out (impact), the working diff, and the cwd.

Constraints: code under `packages/core/**` MUST return `neverthrow` `Result`/`ResultAsync` (no raw throw). The runner is per-user and per-runner isolated — routing MUST stay within the requesting user's provider/credentials. This change is **design-only**; no code is written until `/opsx:apply`.

**Prior art — Factory Router (GA June 2026, confirmed from Factory's docs).** Factory's equivalent feature validates two of our decisions and surfaces one constraint we had not considered:

- It uses **a mix of session and per-request routing**, explicitly tuned to **preserve prompt cache** — because switching models mid-session invalidates the provider prompt cache and erodes the savings. This is the constraint (see Risks).
- It confirms **escalation-by-result**: _"if the selected model struggles to complete the task, Factory Router moves the session to a more capable model."_ Our D5 mirrors this — it is not a novel bet.
- Reported impact: 20–25% token savings on benchmark, ~43% aggregate in production, at 96–99% of frontier pass rate; pool spans Anthropic/OpenAI/Google/NVIDIA + US-hosted open-source. The exact classification algorithm is not disclosed, so our heuristic (D4) is our own, not a reproduction.

## Goals / Non-Goals

**Goals:**

- Add an `'auto'` model value that the runner resolves to a concrete `(provider, model)` at spawn time, with the smallest possible blast radius.
- Keep the routing decision a pure, testable function driven by cheap non-LLM features.
- Ship `escalateTier()` as a pure, tested primitive so v2 can drive escalation without new state.
- Emit telemetry so thresholds are tuned from data, not guesses.
- Leave a clean seam for a v2 LLM classifier without committing to it now.

**Non-Goals:**

- No LLM "gatekeeper" classifier in v1 (Gemma 4 12B / Haiku) — deferred to v2.
- No wired escalation-by-result in v1 (the counters live in a separate engine + prompt-cache cost) — deferred to v2; only the `escalateTier()` primitive ships.
- No server-side or UI-side routing decision; the UI only gains `'auto'` as a selectable value.
- No change to the thread state machine, the WS protocol, or persistence schema beyond accepting `'auto'`.
- No cross-provider routing that would violate per-user runner isolation.
- No automatic cost budgeting / spend caps (possible future work).

## Decisions

### D1 — Routing runs in the runner, just before `startAgent`

The resolution point is `agent-runner` / `agent-lifecycle`, immediately before `startAgent`. Rationale: only here are the live signals (code-graph impact, diff, cwd) and the resolved per-user provider available, and escalation-on-retry naturally lives in the same loop. _Alternative considered:_ deciding at thread creation on the server — rejected because it has no live repo signals and can't re-route on failure. _Alternative:_ a separate routing service — rejected as over-engineered for a pure function.

### D2 — `'auto'` is an additive sentinel, not a new provider

`'auto'` is added to `AgentModel` and accepted by `agentModelSchema`. The runner branches: `model === 'auto'` → call router; else → unchanged. Rationale: zero behavior change for existing threads; the feature is opt-in per thread. _Alternative considered:_ a separate `routingMode` field on `Thread` — rejected as redundant; the model field already expresses "let the system choose."

### D3 — Tiers, not direct model picks

The router outputs a tier (`light | mid | frontier`), then maps tier → concrete model via the registry for the thread's provider. Rationale: decouples heuristics from the model catalog, so adding/retiring a model is a registry edit, not a router edit; escalation becomes "tier + 1". `ModelDefinition` gains `tier`, `relCost` (relative cost, 1 = cheapest), and optional `strengths` (`'code' | 'planning' | 'vision' | 'cheap-bulk'`). _Alternative considered:_ router returns a concrete model id — rejected; couples policy to catalog and complicates escalation.

### D4 — Heuristic feature set (v1, no LLM)

`extractFeatures` produces: `fanOut` (code-graph impact count), `filesTouched` (diff), `promptTokens`, `estContextTokens`, `isFollowUp`, plus the user's `provider`/`permissionMode`. `route(features)` applies ordered rules: context-window fit is a hard filter; high fan-out / refactor-architecture keywords push `frontier`; short prompt + small context + low-effort keywords (rename/typo/simple test) push `light`; everything else is `mid`. Rationale: cheap signals already in hand classify the majority with zero inference cost. The exact thresholds are seeded conservatively and tuned from telemetry (D7).

### D5 — Escalation reuses existing `Session` counters

On a failed attempt that the loop retries, the next route is computed at `previousTier + 1`, derived from `ciAttempts`/`reviewAttempts`/`escalated` already on `Session`. Caps at `frontier`. Only applies to `'auto'` threads. Rationale: escalation-by-result is more reliable than predicting success up front (this is also how Factory Router behaves), and the counters already exist — no new state.

> **⚠️ Open — escalation is likely v2, not v1.** Those counters live in `packages/agent` (`@funny/orchestrator`), a **separate engine** the runtime `agent-runner` does not import; a normal `'auto'` thread spawned via D1 never enters that `Session` loop, so there is nothing to escalate in the v1 path. On top of that, the prompt-cache constraint above means an intra-session model swap has a real cache cost. Both point the same way: **ship spawn-time routing (D1–D4, D6, D7) in v1 and defer escalation to v2**, where it either lands inside `@funny/orchestrator` or a bridge is designed deliberately. This is pending the user's call from the plan review.

### D6 — `neverthrow` boundary

`packages/core/src/routing/router.ts` is pure and returns `Result<{provider, model}, RouteError>`. The runner consumes the `Result` and, on `err`, falls back to `getDefaultModel(provider)` so a routing bug can never block a run. Rationale: required by the core error-handling mandate and gives a safe default.

### D7 — Telemetry to tune thresholds

Each decision logs `{ features, tier, provider, model, escalated, outcome, cost }`. Recording is best-effort (never throws, never blocks the run). Rationale: v1 thresholds are guesses; only real outcomes tell us where `light` fails and where the eventual v2 classifier is actually needed.

## Risks / Trade-offs

- **Wrong-tier picks waste a run** → Escalation-by-result (D5) self-corrects on retry; conservative initial thresholds bias toward `mid`/`frontier` until telemetry justifies more aggressive `light` routing.
- **Heuristics are coarse vs an LLM classifier** → Accepted for v1; the tier seam (D3) lets a v2 classifier slot in as an alternate `route()` implementation without touching callers.
- **Cost estimation (`estContextTokens`) is approximate** → Use it only as a hard upper-bound filter against `contextWindow` (safe direction) plus a soft signal, not a precise budget.
- **Provider has no model for the chosen tier** → Router falls back to the nearest available tier for that provider (spec requirement), never errors.
- **Routing diverges from manual selection silently** → Telemetry + surfacing the resolved model on the thread (already shown via `resolveModelLabel`) keep the choice visible to the user.
- **Per-user isolation violation** → Router is constrained to the thread's resolved provider/credentials (D1); it cannot pick another user's model/runner.
- **Mid-session model swap invalidates the provider prompt cache** → funny resumes conversations via `sessionId`; changing the model on a resumed session throws away the cached prefix and can cost more than the cheaper tier saves. Factory addresses this by keeping routing "cache-aware." v1 avoids the problem entirely by routing **only at spawn** (D1) and treating escalation as v2 (see D5). When escalation is built, it must weigh the cache-invalidation cost against the expected gain, not escalate blindly.

## Migration Plan

- Purely additive; no data migration. Existing threads keep their fixed model and are unaffected.
- Rollout: ship `'auto'` as a non-default, opt-in selectable value. `DEFAULT_MODEL` stays `'opus-4.8'`, so nothing auto-routes unless a user picks `'auto'`.
- Rollback: remove `'auto'` from the picker / schema; fixed-model threads are untouched. The pure router module can remain dormant.

## Open Questions

- Should `'auto'` eventually become the default for new threads once telemetry validates quality? (Out of scope for v1.)
- Do we expose the per-tier model mapping to admins (Factory-style "routing guidance"), or keep it registry-defined in v1? (Lean registry-defined for v1.)
- Where should telemetry land — existing thread/cost tables vs a dedicated routing-decisions store? (To be decided in tasks; prefer reusing existing persistence.)
