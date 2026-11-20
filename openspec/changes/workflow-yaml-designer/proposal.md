## Why

Funny currently stores executable YAML definitions under runtime-owned pipeline paths:
`packages/runtime/src/pipelines/defaults/*.yaml` and `<repo>/.funny/pipelines/*.yaml`.
That makes the runtime package responsible for built-in workflow catalog ownership,
YAML format ownership, parsing, and execution wiring. It also exposes the user-facing
artifact as "pipeline" even though the artifact users edit and version is a workflow.

We want workflows to be versioned project files, visualized and edited with React Flow,
and executed by the runtime without making runtime the owner of the workflow format.
The pipeline engine can remain the generic execution primitive, but workflow YAML should
be a separate product and package boundary.

## What Changes

- Introduce a new `@funny/workflows` workspace package that owns workflow YAML schema,
  parser/validator, serializer, graph conversion, and built-in workflow YAML files.
- Move built-in YAML definitions out of `packages/runtime/src/pipelines/defaults` into
  `packages/workflows/defaults`.
- Replace project workflow discovery with `<repo>/.funny/workflows/*.yaml`.
- Remove support for `.funny/pipelines/*.yaml` for this workflow system. There is no
  compatibility path, alias, fallback, or migration reader.
- Add runtime APIs for listing, reading, validating, saving, and executing workflow YAML
  definitions for the active project.
- Add a React Flow workflow designer in the client that visualizes, edits, validates,
  saves, and runs workflow YAML files.
- Add live run state mapping so the designer can highlight running, completed, skipped,
  failed, and approval-waiting nodes during execution.

## Capabilities

### New Capabilities

- `workflow-yaml-designer`: Versioned workflow YAML catalog, React Flow designer/editor,
  YAML validation/serialization, workflow execution, and live node state visualization.

### Modified Capabilities

- Runtime scheduler pipeline dispatch: load workflow YAML from `@funny/workflows` and
  `.funny/workflows` rather than runtime-owned pipeline YAML paths.

## Impact

- **`packages/workflows`** - New package for workflow YAML schema, parser, serializer,
  graph conversion, built-in defaults, and tests.
- **`packages/pipelines`** - Keep only the generic pipeline engine and execution types;
  remove workflow-specific YAML schema/parsing exports after consumers are moved.
- **`packages/runtime`** - Replace YAML loader/compiler imports with workflow package
  imports, update discovery paths, add workflow management routes, and keep runtime
  action binding in runtime.
- **`packages/client`** - Add React Flow dependency and a Workflow Designer UI with graph,
  inspector, YAML/source view, validation panel, save, and run controls.
- **`packages/shared`** - Add shared DTOs for workflow definitions, workflow graph data,
  validation diagnostics, save requests, run requests, and run state updates.
- **Breaking change** - `.funny/pipelines/*.yaml` and runtime default YAML paths are no
  longer read by workflow execution.
