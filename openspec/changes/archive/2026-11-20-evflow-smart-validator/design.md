## Context

The `@funny/evflow` package provides an Event Modeling DSL with a `validate()` function in `packages/evflow/src/validator.ts`. The validator currently runs 6 check functions that produce ~10 distinct issue codes. All existing checks fall into two categories:

1. **Reference checks** — verify that string references point to existing elements of the correct kind (8 codes)
2. **Structural checks** — detect orphan elements and duplicate sequence names (2 codes)

The validator is called in two places:

- **`EventModel.validate()`** — programmatic validation returning `Result<warnings[], errors[]>`
- **VS Code TS plugin** (`plugin/diagnostics.ts`) — consumes `validate()` output to show squiggles in the editor

The existing architecture is a simple pipeline: `validate(model)` calls each check function, which pushes issues into a shared array. This pattern scales cleanly for additional rules.

## Goals / Non-Goals

**Goals:**

- Add 4 new semantic validation rules as warnings
- Maintain backward compatibility — no existing valid model becomes invalid
- Keep the validator pure (no side effects, deterministic)
- Ensure the VS Code plugin picks up new warnings automatically (it already does — no plugin changes needed)

**Non-Goals:**

- Adding a new `ValidationSeverity` level (e.g., `info`) — all new rules use `warning`
- Changing the validator architecture (pipeline pattern works fine)
- Adding `produces` field to CommandDef (API change deferred)
- Validating the model against actual runtime code (AST cross-referencing)

## Decisions

### 1. Sequence transition table approach

**Decision:** Define a static lookup table of valid `kind → kind` transitions rather than encoding rules procedurally.

```typescript
const VALID_TRANSITIONS: Record<ElementKind, Set<ElementKind>> = {
  command: new Set(['event']),
  event: new Set(['command', 'readModel', 'event']),
  readModel: new Set(['command']),
  automation: new Set([]), // automations don't appear in sequences
};
```

**Rationale:** A table is easier to reason about, test, and extend than scattered if/else. The `event → event` transition is allowed (event chains exist in practice, e.g., domain event triggering integration event) but could be flagged as `info` in the future.

**Alternative considered:** Procedural checks per transition pair. Rejected because it would require ~9 separate conditions and is harder to maintain.

### 2. Cycle detection via inferred causality graph

**Decision:** Build the causality graph from two sources:

- **Sequences** provide `command → event` edges (a command followed by an event in a sequence implies the command produces that event)
- **Automations** provide `event → command` edges (explicit in the model)

Then run DFS with a color/state-based cycle detector.

**Rationale:** The model doesn't have an explicit `command.produces` field, so sequences are the best source for inferring causality. This is a heuristic — it may miss cycles that aren't captured in sequences, but it catches the common case with zero API changes.

**Alternative considered:** Adding a `produces: string[]` field to `CommandDef`. This would make cycle detection exact but changes the public API. Deferred as a future enhancement.

### 3. Dead event = not consumed by ReadModel AND not listened to by Automation

**Decision:** An event is "dead" if it appears in zero `ReadModel.from` arrays AND zero `Automation.on` fields. Events that appear only in sequences are still considered dead — sequences are documentation, not consumption.

**Rationale:** The purpose of an event is to be consumed. An event only in sequences means it's documented but unused. This matches Event Modeling semantics: events exist to feed projections and trigger reactions.

### 4. All new rules are warnings, not errors

**Decision:** Every new rule uses `severity: 'warning'`.

**Rationale:** Semantic rules are opinionated. There are legitimate edge cases (e.g., `event → event` in a sequence for documentation purposes, a newly defined event not yet wired up). Warnings surface the issue without blocking `validate()` from returning `ok()`.

## Risks / Trade-offs

- **[False positives in sequence ordering]** → Some models intentionally use `event → event` for documentation. Mitigation: `event → event` is allowed in the transition table. Only clearly wrong transitions (e.g., `command → command`) are flagged.

- **[Cycle detection is heuristic]** → Only detects cycles for command→event pairs that appear in sequences. Mitigation: documented as a limitation. Adding `produces` to commands in the future makes it exact.

- **[Dead event noise on partial models]** → During development, events may be defined before their consumers. Mitigation: this is a warning, not an error. The check is skipped if the model has zero ReadModels and zero Automations (same pattern as orphan check skipping when no sequences exist).
