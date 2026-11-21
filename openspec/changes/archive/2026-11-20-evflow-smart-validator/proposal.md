## Why

The evflow validator currently has 10 rules that are all "reference checks" (does this element exist? is it the right kind?) and "structural checks" (orphans, duplicates). There are zero semantic rules that understand the meaning of Event Modeling patterns. This means the validator can't catch modeling mistakes like command-to-command transitions in sequences (missing the event), infinite automation loops, or dead events that nothing consumes. Adding semantic validation makes evflow a more reliable design tool and catches real bugs before they reach runtime.

## What Changes

- Add **sequence ordering validation** — detect invalid transitions between element kinds in sequences (e.g., command directly followed by command, readModel producing an event)
- Add **automation cycle detection** — build a directed graph from automation relationships and detect infinite loops via DFS
- Add **dead event detection** — warn when an event is not consumed by any ReadModel or Automation
- Add **empty sequence detection** — warn on sequences with 0 or 1 steps that provide no temporal information
- All new rules emit **warnings** (not errors), keeping backward compatibility with existing models

## Capabilities

### New Capabilities

- `semantic-validation`: Sequence ordering rules, automation cycle detection, dead event detection, and empty sequence checks — all semantic rules that go beyond reference/structural checks

### Modified Capabilities

_None — no existing specs to modify._

## Impact

- **`packages/evflow/src/validator.ts`** — 4 new check functions added to the existing `validate()` pipeline
- **`packages/evflow/src/types.ts`** — No changes needed; existing `ValidationIssue` type already supports new codes via string union
- **`packages/evflow/src/__tests__/validator.test.ts`** — New test cases for each rule
- **`packages/evflow/src/plugin/diagnostics.ts`** — No changes needed; the VS Code plugin already consumes all validation issues generically
- **No breaking changes** — all new rules are warnings, existing behavior is preserved
