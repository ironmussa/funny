## Context

Arcs provide a three-phase workflow for structured agent work: Explore, Plan, and Implement. Currently only two phases have dedicated support (`explore` and `implement`), with planning happening implicitly inside explore threads. The `purpose` column in the `threads` table is already a `TEXT` field with no database-level enum constraint, so adding a third value requires no migration.

Arc prompts are injected in `agent-runner.ts` (lines ~376-401): the runner reads the thread's `purpose`, selects the matching prompt from `arc-prompts.ts`, wraps it in `[ARC PURPOSE]` tags, and prepends it to the system prompt alongside arc artifact context.

## Goals / Non-Goals

**Goals:**

- Add `'plan'` as a first-class `ThreadPurpose` value
- Create a plan-specific system prompt that guides the agent to produce architecture decisions, validate feasibility, and write structured arc artifacts (design.md, tasks.md, specs/)
- Update the UI purpose selector to offer three options when an arc is selected
- Force plan threads to `local` mode (no worktree), same as explore

**Non-Goals:**

- Automated phase transitions (explore → plan → implement) — phases remain user-initiated
- Per-phase model recommendations stored in the Arc record — users pick the model per thread as they do today
- Changes to the arc database schema or artifact file structure
- Modifying pipeline integration with arcs

## Decisions

### 1. `ThreadPurpose` becomes a three-value union

Add `'plan'` to `type ThreadPurpose = 'explore' | 'plan' | 'implement'`.

No database migration needed — the column is `TEXT`. Existing threads with `'explore'` or `'implement'` are unaffected.

**Alternative considered:** Adding an `AgentRole` enum separate from purpose. Rejected because purpose already carries the semantic meaning and is the field used for prompt selection. A separate concept would add indirection without benefit at this stage.

### 2. Plan prompt design

The plan agent sits between explore and implement:

- **Reads** explore artifacts (proposal.md, early design notes)
- **Produces** design.md, tasks.md, specs/ — the structured artifacts that implement threads consume
- **Validates** feasibility by reading actual codebase
- **Does NOT write application code** — same constraint as explore

The prompt emphasizes:

- Concrete decisions over open-ended exploration
- Trade-off analysis with clear rationale
- Structured output (checklist tasks with dependency ordering, spec files per capability)
- Validation against codebase reality (read files, check APIs exist, verify integration points)

**Alternative considered:** Making plan a sub-mode of explore that auto-transitions. Rejected because the user should consciously decide when exploration is done and planning should begin — forcing a transition would undermine the arc's deliberate pacing.

### 3. Prompt selection in agent-runner.ts

Extend the existing `if/else` in `agent-runner.ts` (~line 397) to a three-way check:

```typescript
if (purpose === 'explore') {
  arcPurposePrompt = getExplorePrompt(arc.name);
} else if (purpose === 'plan') {
  arcPurposePrompt = getPlanPrompt(arc.name);
} else {
  arcPurposePrompt = getImplementPrompt(arc.name);
}
```

The `else` default keeps backward compatibility — any thread without an explicit purpose falls through to implement behavior.

### 4. UI: purpose selector with three options

The `NewThreadDialog` already renders a `<Select>` with two `<SelectItem>` entries when an arc is selected. Add a third item for `'plan'`. The local-mode enforcement logic changes from checking `purpose === 'explore'` to checking `purpose !== 'implement'` — both explore and plan force local mode.

### 5. Refine existing prompts

With plan as a separate phase, the explore prompt can be tightened to focus purely on discovery (remove mentions of writing tasks.md and specs, since that's now plan's job). The implement prompt remains unchanged — it already assumes artifacts exist.

## Risks / Trade-offs

- **Risk: Users skip plan phase** → No mitigation needed; plan is optional. Explore threads can still write artifacts if users prefer a two-phase workflow. The prompts work independently.
- **Risk: Plan prompt overlap with explore** → Mitigated by explicit guardrails in each prompt: explore says "discover, don't decide"; plan says "decide, don't implement".
- **Trade-off: Three purpose options add UI complexity** → Acceptable; the selector only appears when an arc is selected, and three options fit cleanly in the existing dropdown.
