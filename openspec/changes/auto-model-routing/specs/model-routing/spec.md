## ADDED Requirements

### Requirement: Auto model selection via sentinel value

The system SHALL accept `'auto'` as a valid `AgentModel` value for a thread. When a thread's model is `'auto'`, the runner SHALL resolve a concrete `(provider, model)` pair at agent spawn time, before `startAgent` is invoked. When the model is any other value, the system SHALL use that fixed value unchanged (no routing).

#### Scenario: Auto resolves to a concrete model at spawn

- **WHEN** a thread with `model = 'auto'` starts an agent
- **THEN** the runner computes task features and resolves a concrete `(provider, model)` from the registry before calling `startAgent`
- **AND** the concrete model id passed to the provider is a real registry model, never the literal string `'auto'`

#### Scenario: Fixed model is untouched

- **WHEN** a thread with `model = 'opus-4.8'` (or any non-`'auto'` value) starts an agent
- **THEN** the router is not consulted and `startAgent` receives the fixed model exactly as today

#### Scenario: Validation accepts auto

- **WHEN** a start/create request specifies `model = 'auto'`
- **THEN** request validation (`agentModelSchema`) accepts it as valid

### Requirement: Tier-based heuristic routing from cheap features

The routing layer SHALL select a model tier (`light | mid | frontier`) from non-LLM task features only: code-graph fan-out, number of files touched, prompt length and keywords, estimated context size versus the candidate model's context window, and the user's provider/permission constraints. The router SHALL NOT call any LLM in v1. The router SHALL be a pure function returning a `neverthrow` `Result`.

#### Scenario: Small isolated task routes light

- **WHEN** the task has a short prompt, a small estimated context, low code-graph fan-out, and matches low-effort keywords (e.g. rename, typo, simple test)
- **THEN** the router selects the `light` tier

#### Scenario: Large or complex task routes frontier

- **WHEN** the task has high code-graph fan-out or refactor/architecture keywords, or its estimated context approaches a tier's context-window limit
- **THEN** the router escalates the selection to `frontier`

#### Scenario: Ambiguous task defaults to mid

- **WHEN** the features match neither the light nor the frontier conditions
- **THEN** the router selects the `mid` tier

#### Scenario: Context window never exceeded

- **WHEN** the estimated context for a task exceeds a candidate model's `contextWindow`
- **THEN** the router does not select that model and chooses one whose context window fits

### Requirement: Provider and permission constraints are respected

The router SHALL only select models available for the thread's resolved provider, and SHALL honor the user's BYOK provider and permission-mode constraints. The router SHALL never route a request to a model the requesting user cannot use.

#### Scenario: Selection stays within the user's provider

- **WHEN** the thread is bound to a specific provider
- **THEN** the resolved model belongs to that provider's registry bucket

#### Scenario: No available model for tier

- **WHEN** the chosen tier has no model available for the provider
- **THEN** the router falls back to the nearest available tier for that provider rather than erroring

### Requirement: Tier escalation primitive (v1) — full escalation deferred to v2

v1 SHALL provide a pure, tested `escalateTier(currentTier)` primitive that returns the next-higher tier and caps at `frontier`, so a later version can drive escalation-by-result. v1 SHALL NOT wire escalation into any run: the retry counters (`ciAttempts`, `reviewAttempts`, `escalated`) live in `packages/agent` (`@funny/orchestrator`), a separate engine the runtime does not import, so a v1 `'auto'` thread has no retry path to escalate; a mid-session model swap would also invalidate the provider prompt cache. Full escalation-by-result — re-routing one tier up on a failed compile/test/review and capping at `frontier` — is a v2 requirement to be specified when the escalation home (inside `@funny/orchestrator` or a deliberate bridge) is chosen.

#### Scenario: escalateTier steps up one tier

- **WHEN** `escalateTier('light')` is called
- **THEN** it returns `'mid'`, and `escalateTier('mid')` returns `'frontier'`

#### Scenario: escalateTier caps at frontier

- **WHEN** `escalateTier('frontier')` is called
- **THEN** it returns `'frontier'` (no higher tier exists)

### Requirement: Routing decision telemetry

The system SHALL record each routing decision with its input features, the chosen tier and model, whether it was an escalation, and the eventual outcome, so thresholds can be tuned later. Telemetry recording SHALL NOT block or fail the agent run.

#### Scenario: Decision is logged

- **WHEN** the router resolves a model for an `'auto'` thread
- **THEN** a telemetry record is emitted containing the features, chosen `(tier, provider, model)`, and escalation flag

#### Scenario: Telemetry failure is non-fatal

- **WHEN** telemetry recording fails
- **THEN** the agent run proceeds normally and the failure is logged, not thrown
