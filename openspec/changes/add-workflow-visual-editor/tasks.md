## 1. Pipeline Graph Model

- [ ] 1.1 Add `WorkflowGraph`, `WorkflowGraphNode`, `WorkflowGraphEdge`, and diagnostic types in `packages/pipelines`
- [ ] 1.2 Implement `pipelineToGraph(parsed)` mapping `depends_on`, `loop.back_to`, and `pipeline:` references to edges
- [ ] 1.3 Implement `graphToPipeline(graph)` for visual edits back to `ParsedPipeline`
- [ ] 1.4 Implement `pipelineToMermaid(parsed)` for export/debugging
- [ ] 1.5 Add tests for sequential, DAG, loop, approval, retry, `when`, and sub-pipeline reference cases

## 2. YAML Serialization and Validation

- [ ] 2.1 Add canonical YAML serializer for `ParsedPipeline` using the existing schema shape
- [ ] 2.2 Add validation helper that returns parse issues plus compile issues in a UI-friendly structure
- [ ] 2.3 Add round-trip tests for built-in default pipelines
- [ ] 2.4 Document comment-preservation limitations for visual edits

## 3. Runtime Workflow API

- [ ] 3.1 Add runtime workflow routes for list/read/validate/save/dispatch/run-status
- [ ] 3.2 Reuse `loadPipelines()` and include source metadata (`built-in`, `user`, `archon`) and file path labels safe for display
- [ ] 3.3 Implement save path containment for `<repoRoot>/.funny/pipelines/*.yaml`
- [ ] 3.4 Dispatch workflows through `SchedulerPipelineDispatcher` with declared inputs
- [ ] 3.5 Store or expose enough run state to map pipeline progress back to node IDs
- [ ] 3.6 Add route tests for list/read/validate/save/dispatch and path traversal rejection

## 4. Client API and State

- [ ] 4.1 Add client workflow API helpers
- [ ] 4.2 Add workflow editor store for selected workflow, draft graph, YAML text, diagnostics, dirty state, and active run status
- [ ] 4.3 Add input resolution for declared pipeline inputs, including required/default display
- [ ] 4.4 Add optimistic validation state and runtime validation result handling

## 5. React Flow Editor UI

- [ ] 5.1 Add `@xyflow/react` and `@dagrejs/dagre` to the main client package
- [ ] 5.2 Build lazy-loaded workflow editor route/panel
- [ ] 5.3 Build workflow list with source badges and search
- [ ] 5.4 Build custom React Flow node components for action kinds (`spawn_agent`, `run_command`, `git_commit`, `git_push`, `create_pr`, `notify`, `set_status`, `set_stage`, `approval`, `pipeline`)
- [ ] 5.5 Build edge rendering for dependencies, loop edges, and pipeline references
- [ ] 5.6 Build inspector forms for common fields and an advanced YAML fragment escape hatch
- [ ] 5.7 Build full YAML preview/editor with validation errors linked to nodes where possible
- [ ] 5.8 Add auto-layout, minimap, fit view, zoom, and selection controls

## 6. Editing Behavior

- [ ] 6.1 Support adding a node from an action palette
- [ ] 6.2 Support connecting nodes to update `depends_on`
- [ ] 6.3 Support deleting nodes with dependency cleanup warnings
- [ ] 6.4 Support duplicating nodes with unique ID generation
- [ ] 6.5 Support editing pipeline inputs
- [ ] 6.6 Support saving built-in workflows as user overrides

## 7. Execution Experience

- [ ] 7.1 Build run input form from declared `inputs`
- [ ] 7.2 Add dispatch button with disabled states for invalid/dirty unsaved workflows
- [ ] 7.3 Show run status on graph nodes and in a compact event log
- [ ] 7.4 Integrate approval waiting state with the existing pipeline approval dialog/store
- [ ] 7.5 Add cancel/retry affordances only if supported by current dispatcher APIs; otherwise leave them out of v1

## 8. Verification

- [ ] 8.1 Add unit tests for graph conversion and serializer
- [ ] 8.2 Add runtime route tests for API behavior and security boundaries
- [ ] 8.3 Add client tests for selecting, editing, validating, saving, and dispatching a workflow
- [ ] 8.4 Run `bun run lint`
- [ ] 8.5 Run `bun run typecheck`
