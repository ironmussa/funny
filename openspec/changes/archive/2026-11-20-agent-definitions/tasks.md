## 1. Define AgentDefinition interface

- [x] 1.1 Add `AgentDefinition` interface to `packages/shared/src/types.ts` with fields: name, label, systemPrompt (string | function), model, provider, permissionMode
- [x] 1.2 Add `ThreadPurpose` value `'plan'` to support the arc plan agent

## 2. Create agent registry

- [x] 2.1 Create `packages/runtime/src/services/agent-registry.ts` with `BUILTIN_AGENTS` object containing all seven built-in agents (reviewer, corrector, precommitFixer, testFixer, arcExplore, arcPlan, arcImplement)
- [x] 2.2 Implement `resolveAgent(base, overrides?)` helper that merges partial overrides onto a base AgentDefinition
- [x] 2.3 Move prompt content from `pipeline-prompts.ts` into the corresponding agent definitions (reviewer, corrector, precommitFixer, testFixer)
- [x] 2.4 Move prompt content from `arc-prompts.ts` into arc agent definitions (arcExplore, arcPlan, arcImplement)

## 3. Extend SpawnAgentOpts

- [x] 3.1 Add optional `agent?: AgentDefinition` field to `SpawnAgentOpts` in `packages/runtime/src/pipelines/types.ts`
- [x] 3.2 Update `ActionProvider.spawnAgent()` implementation in pipeline-manager to resolve model/mode from agent when provided

## 4. Refactor pipeline contexts

- [x] 4.1 Replace `reviewerModel`/`reviewerPrompt`/`correctorModel`/`correctorPrompt` in `CodeReviewPipelineContext` with `reviewer: AgentDefinition` and `corrector: AgentDefinition`
- [x] 4.2 Update `code-review.pipeline.ts` nodes to use `ctx.reviewer` and `ctx.corrector` agent definitions in spawnAgent calls
- [x] 4.3 Replace `fixerModel`/`fixerPrompt` in `CommitPipelineContext` with `fixer: AgentDefinition`
- [x] 4.4 Update `commit.pipeline.ts` to use `ctx.fixer` agent definition
- [x] 4.5 Replace `fixerModel`/`fixerPrompt` in `PrePushPipelineContext` with `fixer: AgentDefinition`
- [x] 4.6 Update `pre-push.pipeline.ts` to use `ctx.fixer` agent definition
- [x] 4.7 Replace scattered agent fields in `CodeQualityContext` with agent definition references and update `code-quality.pipeline.ts` sub-pipeline calls

## 5. Refactor pipeline-manager

- [x] 5.1 Update `pipeline-manager.ts` to build `AgentDefinition` objects using `resolveAgent()` with DB pipeline config as overrides when constructing pipeline contexts

## 6. Refactor arc agent injection

- [x] 6.1 Update `agent-runner.ts` to resolve arc agents from registry by thread purpose instead of calling `getExplorePrompt()`/`getImplementPrompt()` directly
- [x] 6.2 Add `getArcAgent(purpose, arcName)` helper to the registry that returns the resolved agent with the arc name interpolated into the system prompt

## 7. Update UI

- [x] 7.1 Add `'plan'` option to purpose selector in `NewThreadDialog.tsx`
- [x] 7.2 Update local-mode enforcement to apply for both `explore` and `plan` purposes

## 8. Validate

- [x] 8.1 Verify the project builds without type errors (`bun run build`)
