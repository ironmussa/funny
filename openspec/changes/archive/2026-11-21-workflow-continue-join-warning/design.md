# Design

## Context

See proposal.md - Why. Today the parser has one outcome per flow: `parseWorkflowYaml` returns
`{ ok: true, workflow }` or `{ ok: false, error }`, and every issue from the graph checks in
`packages/workflows/src/validate.ts` (run inside the schema) turns into a refusal.
`WorkflowDiagnostic` is `{ path, message }` with no severity, and the editor
(`WorkflowsSettings.tsx`) disables save and run with `diagnostics.length > 0` in four places.
Flows are parsed in four call sites: the catalog (`packages/workflows/src/catalog.ts`, used by
the runtime), the runtime validate route, the factory (`factory-flow.ts`) and the orchestrator
factory step (`factory-workflow.ts`).

The `workflow-engine` capability is introduced by `workflow-dag-engine`, which is not archived
yet. This change archives after it.

## Goals / Non-Goals

**Goals:**
- One non-blocking warning, computed once in the parser and surfaced in the editor, the API and
  the load logs.
- A severity field that later warnings can reuse.

**Non-Goals:**
- Changing the `on_error: continue` semantics or restoring the old behavior.
- Turning the warning into an error, or a flag to opt out of it besides an explicit
  `trigger_rule`.
- Other warnings (unused inputs, unreachable nodes); the mechanism allows them, this change
  adds none.

## Decisions

**Warnings travel on the valid result, not through the schema.** The success branch becomes
`{ ok: true, workflow, warnings: WorkflowDiagnostic[] }`, always present (empty when none).
The warning check runs after the schema accepted the flow, as a plain function over the parsed
workflow next to `graphIssues`. Alternative considered: emitting warnings from inside the zod
refinement with a marker. Rejected: any zod issue fails the parse, and filtering them back out
couples the check to zod's internals.

**Warnings live in the parse result, not in the parsed workflow.** `ParsedWorkflow` is what
the engine and compiler consume and what the API returns as `parsed`; putting warnings there
would leak editor concerns into execution. The catalog entry keeps the warnings next to the
workflow so the definition route can return them.

**Severity is optional, default `error`.** `WorkflowDiagnostic` gets
`severity?: 'error' | 'warning'`. Existing producers (route name mismatch, missing inputs,
parse failures) stay errors without being touched. Client checks become
`diagnostics.some(isError)` where `isError = (d) => d.severity !== 'warning'`, defined once
in shared so the four editor sites and any later consumer agree. Alternative: a separate
`warnings` array in the API responses. Rejected: the editor already renders one list keyed by
path, and two arrays would need two renderers.

**Silenced by any explicit `trigger_rule`.** The parsed node has to keep whether the author
wrote `trigger_rule` (the schema default fills `all_success`). If the parsed shape already
loses that distinction, the check reads the raw YAML node before defaults apply. Writing
`all_success` explicitly is a decision, so it must not warn.

**Path and wording.** The warning's path points at the dependent (`nodes[i].trigger_rule`),
which is where the fix goes. One warning per dependent, naming every `continue` dependency it
has, so a node with two such dependencies gets one line.

**Logging at load.** The catalog logs warnings once per load (flow name, path, message) at
`warn` level; the factory and the orchestrator step log the same at their parse call. No
dedup across reloads: flows load rarely and repeating the warning on each load is the point.

## Risks / Trade-offs

- [Warning fatigue in flows where skipping is intended] → An explicit `trigger_rule:
  all_success` silences it, and the message says so.
- [Client and runtime deployed at different versions] → An old client reading a warning
  without understanding severity would block on it. Acceptable: the client and runtime ship
  together; a newer client reading an old runtime sees no severities and treats all as errors,
  as today.
- [Four parse call sites drift] → All of them get warnings from `parseWorkflowYaml`; none
  computes its own.

## Migration Plan

Additive. No stored data changes. Rollback is reverting the change; flows keep loading the
same way in both directions.
