## Context

Today, agent roles exist only as implicit patterns — each `spawnAgent()` call site manually assembles a prompt, picks a model from a context field, and hardcodes a permission mode string. The same "reviewer" concept is defined in three separate places: the prompt in `pipeline-prompts.ts`, the model in `CodeReviewPipelineContext.reviewerModel`, and the mode literal `'plan'` at the call site. Arc agents follow the same pattern — `arc-prompts.ts` has the prompts, the model comes from the thread record, and the mode is either implicit or hardcoded.

The `SpawnAgentOpts` interface in `pipelines/types.ts` already accepts `prompt`, `model`, `mode`, and `cwd` — but these are always assembled ad-hoc from scattered context fields rather than from a coherent agent object.

## Goals / Non-Goals

**Goals:**

- Define `AgentDefinition` as a first-class interface that groups all properties of an agent role
- Create a registry of built-in agent definitions for all existing roles (pipeline + arc)
- Refactor pipeline contexts and arc prompt injection to use `AgentDefinition`
- Make `spawnAgent()` accept an `AgentDefinition` so pipelines pass the object rather than individual fields
- Keep full backward compatibility — no API or DB changes

**Non-Goals:**

- User-defined custom agents (future work — would need DB storage + CRUD API)
- Agent composition or chaining (agents calling other agents)
- Changing the `SpawnAgentOpts` signature in a breaking way
- Database migration or schema changes
- Agent versioning or history

## Decisions

### 1. AgentDefinition interface

```typescript
interface AgentDefinition {
  /** Unique identifier for this agent role (e.g. 'reviewer', 'corrector', 'arc-explore'). */
  name: string;
  /** Human-readable display label. */
  label: string;
  /** The system prompt template. May contain `{{arcName}}` or other placeholders. */
  systemPrompt: string | ((context: Record<string, string>) => string);
  /** Default model for this agent role. */
  model: AgentModel;
  /** Default provider. */
  provider: AgentProvider;
  /** Default permission mode. */
  permissionMode: PermissionMode;
}
```

The `systemPrompt` field accepts either a static string or a function that receives a context object (e.g. `{ arcName: 'add-caching', commitSha: 'abc123' }`) and returns the prompt string. This handles both pipeline prompts (which need dynamic data like commit SHA) and arc prompts (which need the arc name).

**Alternative considered:** Separate `SystemPromptTemplate` type with explicit placeholder syntax. Rejected because a function is simpler, type-safe, and already matches the pattern used by `getExplorePrompt(arcName)`.

### 2. Agent registry as a simple module

Create `packages/runtime/src/services/agent-registry.ts` that exports:

```typescript
// Built-in agent definitions
export const BUILTIN_AGENTS = {
  // Pipeline agents
  reviewer: AgentDefinition,
  corrector: AgentDefinition,
  precommitFixer: AgentDefinition,
  testFixer: AgentDefinition,

  // Arc agents
  arcExplore: AgentDefinition,
  arcPlan: AgentDefinition,
  arcImplement: AgentDefinition,
} as const;

// Helper to resolve an agent with user overrides
export function resolveAgent(
  base: AgentDefinition,
  overrides?: Partial<Pick<AgentDefinition, 'model' | 'provider' | 'systemPrompt'>>,
): AgentDefinition;
```

The registry is a plain object, not a class or service. The `resolveAgent()` helper merges user-provided overrides (from pipeline config or thread settings) on top of built-in defaults.

**Alternative considered:** A singleton service with `register()`/`get()` methods. Rejected as over-engineered for built-in agents — a module export is simpler and tree-shakeable. Can be upgraded to a service later if user-defined agents are added.

### 3. SpawnAgentOpts accepts AgentDefinition

Extend `SpawnAgentOpts` with an optional `agent` field:

```typescript
interface SpawnAgentOpts {
  prompt: string;
  cwd: string;
  mode?: 'plan' | 'autoEdit' | 'confirmEdit';
  model?: string;
  context?: string;
  /** Optional agent definition — if provided, model and mode default to agent's values. */
  agent?: AgentDefinition;
}
```

When `agent` is provided, `model` and `mode` default to the agent's values but can still be overridden by explicit `model`/`mode` fields. The `prompt` field remains required — the agent's `systemPrompt` is injected as a prefix or system context, not as the user prompt.

This is backward compatible: existing call sites that don't pass `agent` work unchanged.

### 4. Pipeline context refactor

Replace scattered fields with `AgentDefinition` objects:

```typescript
// Before:
interface CodeReviewPipelineContext {
  reviewerModel?: string;
  reviewerPrompt?: string;
  correctorModel?: string;
  correctorPrompt?: string;
}

// After:
interface CodeReviewPipelineContext {
  reviewer: AgentDefinition;
  corrector: AgentDefinition;
}
```

The `pipeline-manager.ts` builds these by calling `resolveAgent()` with the DB pipeline config as overrides:

```typescript
reviewer: resolveAgent(BUILTIN_AGENTS.reviewer, {
  model: pipeline.reviewModel,
  systemPrompt: pipeline.reviewerPrompt,
}),
```

### 5. Arc agent resolution

Replace the `if/else` chain in `agent-runner.ts` with a registry lookup:

```typescript
// Before:
if (purpose === 'explore') {
  arcPurposePrompt = getExplorePrompt(arc.name);
} else {
  arcPurposePrompt = getImplementPrompt(arc.name);
}

// After:
const arcAgent = getArcAgent(purpose, arc.name);
arcPurposePrompt =
  typeof arcAgent.systemPrompt === 'function'
    ? arcAgent.systemPrompt({ arcName: arc.name })
    : arcAgent.systemPrompt;
```

This also naturally supports the `'plan'` purpose from the `arc-phase-agents` change — it's just another entry in the registry.

### 6. Pipeline prompts consolidation

Move prompt content from `pipeline-prompts.ts` into the agent definitions in the registry. The `buildReviewerPrompt()`, `buildCorrectorPrompt()`, etc. functions become the `systemPrompt` functions of their respective `AgentDefinition` entries. The `pipeline-prompts.ts` file can be kept as a thin re-export layer or deprecated.

Similarly, `arc-prompts.ts` prompt content moves into the arc agent definitions. The file becomes unnecessary.

## Risks / Trade-offs

- **Risk: Pipeline contexts become coupled to AgentDefinition** → Mitigated by `resolveAgent()` which always produces a complete AgentDefinition from partial overrides. Pipelines never need to handle missing fields.
- **Risk: systemPrompt as a function adds complexity** → Mitigated by keeping the function signature simple (`Record<string, string> => string`). Static prompts can remain as strings. The registry handles both cases transparently.
- **Trade-off: Two ways to pass model/mode to spawnAgent** → Acceptable during migration. The `agent` field provides defaults, explicit `model`/`mode` fields override. After migration, direct fields can be deprecated.
- **Trade-off: Moving prompts to registry reduces locality** → Pipeline files no longer contain their own prompt text. Mitigated by clear naming (`BUILTIN_AGENTS.reviewer.systemPrompt`) and the fact that prompts were already in separate files (`pipeline-prompts.ts`, `arc-prompts.ts`).
