## 1. Empty Sequence Detection

- [x] 1.1 Add `checkEmptySequences` function to `validator.ts` — emit `EMPTY_SEQUENCE` warning for sequences with fewer than 2 steps
- [x] 1.2 Add tests for empty sequence detection: 0 steps, 1 step, 2+ steps (no warning)

## 2. Sequence Ordering Validation

- [x] 2.1 Define `VALID_TRANSITIONS` lookup table in `validator.ts` mapping each `ElementKind` to its set of valid successor kinds
- [x] 2.2 Add `checkSequenceOrdering` function — iterate consecutive pairs in each sequence, skip pairs with unknown elements, emit `SEQUENCE_INVALID_TRANSITION` warning for invalid transitions
- [x] 2.3 Add tests for all invalid transitions: command→command, readModel→event, readModel→readModel, command→readModel
- [x] 2.4 Add tests for valid transitions: command→event, event→command, event→readModel, event→event, readModel→command

## 3. Dead Event Detection

- [x] 3.1 Add `checkDeadEvents` function — collect all events consumed by ReadModels (via `from`) and Automations (via `on`), warn on events not in either set. Skip check if model has zero ReadModels and zero Automations
- [x] 3.2 Add tests: event consumed by ReadModel only (no warning), event listened by Automation only (no warning), event with no consumers (warning), model with no ReadModels/Automations (skip)

## 4. Automation Cycle Detection

- [x] 4.1 Add `checkAutomationCycles` function — build causality graph: infer command→event from sequences (consecutive command followed by event), extract event→command from automations. Run DFS cycle detection. Emit `AUTOMATION_CYCLE` warning with cycle path in message. Skip if no sequences exist
- [x] 4.2 Add tests: simple 2-node cycle, multi-node cycle (A→EvtA→B→EvtB→A), no cycle (DAG), no sequences (skip)

## 5. Integration

- [x] 5.1 Wire all 4 new check functions into the `validate()` pipeline in `validator.ts`
- [x] 5.2 Run full test suite (`bun test` in packages/evflow) and verify all tests pass
- [x] 5.3 Validate against the real runtime model (`packages/runtime/src/services/evflow.model.ts`) — ensure no unexpected warnings on the existing model
