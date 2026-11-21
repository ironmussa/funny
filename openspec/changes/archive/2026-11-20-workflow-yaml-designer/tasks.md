## 1. Workflow Package Boundary

- [x] 1.1 Create `packages/workflows` workspace package with exports for schema, parser, serializer, graph conversion, catalog loading, and types
- [x] 1.2 Move workflow YAML schema and parser out of `@funny/pipelines` into `@funny/workflows`
- [x] 1.3 Move built-in YAML files from `packages/runtime/src/pipelines/defaults` to `packages/workflows/defaults`
- [x] 1.4 Update package exports and workspace dependencies so client/runtime tests can import workflow types without importing runtime
- [x] 1.5 Add unit tests for workflow parsing, validation errors, serialization round trips, and built-in catalog loading

## 2. Clean Path Change

- [x] 2.1 Replace loader discovery of `<repo>/.funny/pipelines/*.yaml` with `<repo>/.funny/workflows/*.yaml`
- [x] 2.2 Remove default YAML lookup from `packages/runtime/src/pipelines/defaults`
- [x] 2.3 Ensure `.funny/pipelines` is not read, aliased, migrated, or treated as a fallback
- [x] 2.4 Update user-facing docs/comments/errors to use workflow terminology and `.funny/workflows`
- [x] 2.5 Add regression tests proving `.funny/workflows` overrides built-ins and `.funny/pipelines` files are ignored

## 3. Workflow Graph Conversion

- [x] 3.1 Add `workflowToGraph()` to convert parsed workflow YAML into React Flow neutral nodes/edges
- [x] 3.2 Add `graphToWorkflow()` or equivalent structured edit helpers to update the parsed model from graph edits
- [x] 3.3 Represent dependency, loop, and subworkflow references as distinct edge/node metadata
- [x] 3.4 Add tests for roots, `depends_on`, fan-in, fan-out, loop edges, self-loops, conditional nodes, retry nodes, approval nodes, and subworkflow nodes

## 4. Runtime Workflow APIs

- [x] 4.1 Add shared workflow DTOs for summaries, definitions, diagnostics, graph data, save requests, run requests, and node run state
- [x] 4.2 Add runtime/server routes to list workflows, read one workflow, validate YAML, save project overrides, run workflows, and cancel runs
- [x] 4.3 Reuse project path resolution and auth checks before reading or writing project workflow files
- [x] 4.4 Delegate workflow execution to the existing scheduler dispatcher while exposing workflow terminology to the client
- [x] 4.5 Add route tests for auth, list/read, validation failures, save, run, cancel, and project override precedence

## 5. Runtime Compiler And Events

- [x] 5.1 Rename or wrap YAML compiler/loader concepts around workflow terminology while keeping the generic pipeline engine underneath
- [x] 5.2 Update scheduler adapters to load from `@funny/workflows` and `.funny/workflows`
- [x] 5.3 Emit node-level workflow run state updates with run id, workflow name, node id, status, and metadata
- [x] 5.4 Map approval waits to `waiting_approval` node state
- [x] 5.5 Add tests for run state emission on completed, skipped, failed, looped, and approval-waiting nodes

## 6. Client Workflow Designer

- [x] 6.1 Add `@xyflow/react` to the main client package and lazy-load the designer route/screen
- [x] 6.2 Add workflow API client methods and a run-state store
- [x] 6.3 Build a Workflows screen separate from the existing DB-backed `PipelineSettings`
- [x] 6.4 Build React Flow graph view with custom workflow nodes, dependency edges, loop edges, controls, minimap, fit view, selection, and search/filter support
- [x] 6.5 Build inspector editing for node id, action type/config, `depends_on`, `when`, `on_error`, retry, and loop settings
- [x] 6.6 Add YAML source panel with validation diagnostics and source-to-graph refresh
- [x] 6.7 Add save/create-override flow for built-in workflows and normal save flow for project workflows
- [x] 6.8 Add run controls with inputs form, active run state, cancel, and live node highlighting
- [x] 6.9 Add focused component tests for graph conversion integration, validation blocking, save flow, and run-state highlighting

## 7. Verification

- [x] 7.1 Run targeted workflow package tests
- [x] 7.2 Run targeted runtime route/compiler tests
- [x] 7.3 Run targeted client tests for the designer
- [x] 7.4 Run `bun run lint`
- [x] 7.5 Run `bun run typecheck`
