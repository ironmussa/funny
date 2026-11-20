## 1. Registry metadata (shared)

- [ ] 1.1 Extend `ModelDefinition` in `packages/shared/src/models.ts` with `tier: 'light' | 'mid' | 'frontier'`, `relCost: number`, and optional `strengths: ('code'|'planning'|'vision'|'cheap-bulk')[]`
- [ ] 1.2 Populate `tier`/`relCost`/`strengths` for every entry in `MODEL_REGISTRY`
- [ ] 1.3 Add `'auto'` to the `AgentModel` union
- [ ] 1.4 Add helpers `getModelsByTier(provider, tier)` and `pickModelForTier(provider, tier)` (with nearest-available-tier fallback)
- [ ] 1.5 Ensure `resolveModelId`/`getDefaultModel` handle `'auto'` safely (never pass `'auto'` to a provider)

## 2. Pure router (core, neverthrow)

- [ ] 2.1 Create `packages/core/src/routing/types.ts` with `RouteFeatures`, `RouteDecision`, `RouteError`
- [ ] 2.2 Create `packages/core/src/routing/router.ts` exporting `route(features): Result<RouteDecision, RouteError>` (context-window hard filter → keyword/fan-out rules → tier → `pickModelForTier`)
- [ ] 2.3 Implement `extractFeatures` inputs contract (fanOut, filesTouched, promptTokens, estContextTokens, isFollowUp, provider, permissionMode) — pure, no IO
- [ ] 2.4 Add `escalateTier(currentTier)` helper capping at `frontier`
- [ ] 2.5 Export the routing module from its own barrel (`packages/core/src/routing/index.ts`) and re-export from the core root index

## 3. Feature collection (runtime)

- [ ] 3.1 Add a runtime helper to gather code-graph fan-out / impact count for the task (or a cheap proxy when unavailable)
- [ ] 3.2 Add a helper to compute diff `filesTouched` for follow-up turns
- [ ] 3.3 Estimate `promptTokens` and `estContextTokens` from prompt + gathered context
- [ ] 3.4 Assemble `RouteFeatures` from thread/project/cwd + the helpers above

## 4. Wire routing into spawn (runtime)

- [ ] 4.1 In `agent-runner`/`agent-lifecycle`, before `startAgent`, branch on `thread.model === 'auto'`
- [ ] 4.2 On `'auto'`, build features, call `route(...)`, and on `ok` pass the concrete `(provider, model)` to `startAgent`
- [ ] 4.3 On `err`, fall back to `getDefaultModel(provider)` and log (never block the run)
- [ ] 4.4 Confirm non-`'auto'` threads bypass the router entirely (unchanged path)

## 5. Escalation by result (agent loop) — DEFERRED TO v2

> Not implemented in v1. The retry counters (`ciAttempts`/`reviewAttempts`/`escalated`) live in `packages/agent` (`@funny/orchestrator`), a separate engine the runtime `agent-runner` does not import — a normal `'auto'` thread spawned via group 4 never enters that `Session` loop, so there is no v1 path to hook. A mid-session model swap also invalidates the provider prompt cache (see design Risks). v2 either lands escalation inside `@funny/orchestrator` or designs a deliberate bridge, weighing cache cost against expected gain. `escalateTier()` (task 2.4) ships in v1 as a pure, tested primitive so v2 can consume it.

- [ ] ~~5.1 In `packages/agent` retry path, derive `previousTier` from `ciAttempts`/`reviewAttempts`/`escalated`~~ (v2)
- [ ] ~~5.2 On retry of an `'auto'` thread, re-route at `escalateTier(previousTier)` and cap at `frontier`~~ (v2)
- [ ] ~~5.3 Ensure fixed-model threads keep the same model on retry (no escalation)~~ (v2)

## 6. Validation & client

- [ ] 6.1 Update `agentModelSchema` in `packages/runtime/src/validation/schemas.ts` to accept `'auto'`
- [ ] 6.2 Add `'auto'` to the client model picker with label + i18n key (`thread.model.auto`)
- [ ] 6.3 Ensure `resolveModelLabel` shows the resolved concrete model for `'auto'` threads (with an "auto" indicator) and add `data-testid`

## 7. Telemetry

- [ ] 7.1 Define a routing-decision record shape `{ features, tier, provider, model, escalated, outcome, cost }`
- [ ] 7.2 Emit the record at decision time (best-effort; never throws, never blocks)
- [ ] 7.3 Record the eventual `outcome`/`cost` against the decision when the run resolves

## 8. Tests

- [ ] 8.1 Unit-test `route()` per spec scenarios (light/mid/frontier, context-window filter, provider constraint, nearest-tier fallback)
- [ ] 8.2 Unit-test `escalateTier()` (light→mid→frontier, caps at frontier)
- [ ] 8.3 Runtime test: `'auto'` thread resolves a concrete model before `startAgent`; fixed model bypasses router; `err` falls back to default
- [ ] ~~8.4 Regression test: failed `'auto'` attempt escalates one tier on retry; fixed-model retry does not~~ (deferred with group 5 → v2)
- [ ] 8.5 Validation test: `agentModelSchema` accepts `'auto'`

## 9. Verify

- [ ] 9.1 `bun run typecheck` clean
- [ ] 9.2 `bun run build` clean
- [ ] 9.3 Relevant package test suites pass (core/runtime/shared)
