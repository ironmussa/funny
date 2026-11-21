# Proposal

## Why

`workflow-dag-engine` changes what `on_error: continue` means: a failing node with `continue`
is now marked failed, and a dependent with the default join (`all_success`) is skipped. Before,
the failure was swallowed and the dependents ran. A user flow in `.funny/workflows/` that relied
on the old behavior keeps loading and its runs still end `completed`, but its dependent nodes
stop running and nothing tells the author why. The bundled flows are already migrated; user
flows in other repositories are not, so the change has to announce itself where authors look.

## What Changes

- The workflow parser reports **warnings** next to a valid result. A warning never makes a
  flow fail to load, save or run.
- New warning: a node that depends on a node with `on_error: continue` and declares no
  `trigger_rule` gets _"`<dependent>` is skipped if `<node>` fails (on_error: continue). Add
  `trigger_rule: all_done` if it must run anyway."_ Declaring any `trigger_rule` on the
  dependent, `all_success` included, silences it.
- Workflow diagnostics carry a severity, `error` or `warning`. Diagnostics without one are
  errors, so existing producers keep their meaning.
- The validate and definition endpoints of the workflow API return the warnings of a flow that
  parses.
- The workflow editor shows warnings without blocking: saving and running are disabled only by
  errors.
- The runtime and the factory log the warnings of a flow when they load it.
- **BREAKING (documented, not new):** the `on_error: continue` change from
  `workflow-dag-engine` gets a "Breaking change" section in its PR, with the before, the after
  and the migration rule, and a line in the openwiki pipelines page.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `workflow-engine`: adds a requirement that flows report non-blocking warnings, starting with
  dependents of `on_error: continue` that rely on the default join. The capability is
  introduced by `workflow-dag-engine`, which this change follows.

## Impact

- `packages/shared/src/types/workflows.ts`: `WorkflowDiagnostic` gains an optional `severity`.
- `packages/workflows`: the parse result carries `warnings`; a new graph check produces them.
- `packages/runtime/src/routes/workflows.ts`: validate and definition responses include the
  warnings.
- `packages/client/src/components/WorkflowsSettings.tsx`: the four places that block on
  `diagnostics.length > 0` count only errors; the diagnostics list shows warnings apart.
- Runtime and server (factory) flow loading: log the warnings.
- Docs: openwiki pipelines page and the `workflow-dag-engine` PR description.
- No database, dependency or engine behavior change.
