## Why

Funny already supports YAML-defined pipelines under `.funny/pipelines/*.yaml` and built-in runtime defaults, but authoring them is text-only. Users have to understand `depends_on`, `pipeline:` composition, `when`, `retry`, approval nodes, and loops by reading YAML. There is no first-class way to inspect the workflow shape before running it, edit the graph safely, or trigger a selected workflow from the same surface.

A React Flow workflow editor would make YAML pipelines approachable and safer: users can see DAG structure, detect broken dependencies visually, edit nodes with schema-aware forms, inspect generated YAML, and execute a selected workflow through the existing runtime dispatcher.

## What Changes

- Add a workflow visualizer/editor for Funny YAML pipelines using React Flow.
- Convert parsed pipeline YAML into a graph model with nodes, edges, labels, warnings, and execution metadata.
- Add a bidirectional editing path: visual graph edits update the parsed workflow model and serialize back to YAML.
- Add runtime APIs to list visible workflow YAMLs, read/validate one, save user overrides, and dispatch a workflow with inputs.
- Add an execution panel that streams pipeline/run progress onto the graph by highlighting running, completed, failed, skipped, and approval-waiting nodes.
- Keep built-in pipelines read-only by default; saving a built-in creates or updates the corresponding `.funny/pipelines/<name>.yaml` override.

## Capabilities

### New Capabilities

- `workflow-visual-editor`: Visualize, edit, validate, save, and execute Funny YAML workflows.
- `workflow-graph-model`: Convert Funny pipeline YAML into React Flow-compatible nodes and edges and serialize graph edits back to YAML.
- `workflow-run-monitoring`: Display live execution status and approval waits on the workflow graph.

### Modified Capabilities

- `pipeline-yaml-runtime`: Expose read/list/validate/save/dispatch operations for YAML pipelines without duplicating scheduler execution logic.

## Impact

- **Pipelines package**: Add graph conversion, YAML serialization helpers, and focused tests around parser/schema round trips.
- **Runtime**: Add workflow routes for listing, reading, validating, saving overrides, dispatching, and returning run state.
- **Scheduler/runtime bridge**: Reuse `SchedulerPipelineDispatcher`, `YamlPipelineLoader`, and `RuntimeActionProvider` rather than creating a second executor.
- **Client**: Add React Flow and dagre to the main client, plus a workflow editor screen/panel with graph, inspector, YAML preview, inputs form, and run monitor.
- **Security**: Restrict save paths to `.funny/pipelines/*.yaml` under the active repo root and keep validation at the runtime boundary.
- **Tests**: Add package tests for graph conversion/serialization, runtime route tests, and client tests for core edit/run flows.
