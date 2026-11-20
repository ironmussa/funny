## Why

Agent configuration is scattered across the codebase — model in one field, prompt in another, permission mode hardcoded inline at the `spawnAgent()` call site. There is no single object that says "this is the reviewer agent" with all its properties together. This makes it hard to reason about agents, configure them from the UI, or reuse them across pipelines and arcs. A unified `AgentDefinition` object would consolidate name, system prompt, model, provider, and permission mode into one entity that both pipelines and arcs can reference.

## What Changes

- Define an `AgentDefinition` interface in `packages/shared/src/types.ts` that groups all agent configuration (name, systemPrompt, model, provider, permissionMode) into a single object
- Create a built-in agent registry in `packages/runtime/src/services/agent-registry.ts` with default definitions for all existing agent roles (reviewer, corrector, precommit-fixer, test-fixer, explore, plan, implement)
- Refactor pipeline contexts (`CodeReviewPipelineContext`, `CodeQualityContext`, `PrePushPipelineContext`, `CommitPipelineContext`) to accept `AgentDefinition` objects instead of separate `reviewerModel`/`reviewerPrompt`/`correctorModel`/`correctorPrompt` fields
- Refactor `SpawnAgentOpts` in pipeline types to accept an optional `AgentDefinition` alongside prompt/model/mode
- Refactor arc prompt injection in `agent-runner.ts` to resolve `AgentDefinition` by purpose instead of calling separate `getExplorePrompt()`/`getImplementPrompt()` functions
- Update `pipeline-manager.ts` to construct `AgentDefinition` objects from the pipeline DB record before passing them to pipeline contexts
- Update `PipelineSettings.tsx` to present agent configuration as grouped sections (one card per agent role) instead of individual scattered fields

## Capabilities

### New Capabilities

- `agent-definition`: The `AgentDefinition` interface, built-in agent registry, and integration into both pipeline and arc agent spawning

### Modified Capabilities

## Impact

- **`packages/shared/src/types.ts`** — New `AgentDefinition` interface
- **`packages/runtime/src/services/agent-registry.ts`** — New file with built-in agent definitions
- **`packages/runtime/src/pipelines/types.ts`** — `SpawnAgentOpts` extended to accept `AgentDefinition`
- **`packages/runtime/src/pipelines/code-review.pipeline.ts`** — Context uses `AgentDefinition` instead of loose fields
- **`packages/runtime/src/pipelines/code-quality.pipeline.ts`** — Same refactor
- **`packages/runtime/src/pipelines/pre-push.pipeline.ts`** — Same refactor
- **`packages/runtime/src/pipelines/commit.pipeline.ts`** — Same refactor
- **`packages/runtime/src/services/pipeline-manager.ts`** — Builds `AgentDefinition` from DB record
- **`packages/runtime/src/services/agent-runner.ts`** — Uses registry for arc agent resolution
- **`packages/runtime/src/services/arc-prompts.ts`** — Prompts moved into `AgentDefinition` entries in registry
- **`packages/client/src/components/PipelineSettings.tsx`** — Agent config grouped by role
- No database migration — the DB schema stores the same fields, only the in-memory representation changes
- No breaking API changes — thread creation and pipeline creation APIs remain the same
