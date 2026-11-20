## Context

The YAML pipeline stack is split across three layers:

- `@funny/pipelines` parses and validates YAML with `parsePipelineYaml`, Zod schema types, Mustache interpolation helpers, JSONata predicates, and the generic pipeline engine.
- `@ironmussa/funny-runtime` loads built-in and user YAML files with `yaml-loader.ts`, compiles them with `yaml-compiler.ts`, and binds YAML actions to `RuntimeActionProvider`.
- `@funny/thread-scheduler` dispatches compiled pipelines through `SchedulerPipelineDispatcher`.

The client already supports visualizer plugins and Mermaid, but the main client does not include React Flow. `packages/evflow/viewer` already demonstrates `@xyflow/react` plus `@dagrejs/dagre` for graph layout, so this change should reuse that proven library choice in the product UI instead of inventing a graph renderer.

## Goals / Non-Goals

**Goals:**

- Visualize built-in and user YAML pipelines as a React Flow graph.
- Support practical editing for v1: add/remove nodes, connect dependencies, edit node fields, edit inputs, toggle retry/error/condition settings, and save YAML.
- Execute a workflow from the editor with declared inputs and show live node/run status.
- Preserve YAML as the source of truth.
- Avoid a second workflow execution path.
- Keep editing constrained by the existing `pipelineSchema`.

**Non-Goals:**

- General-purpose BPMN or arbitrary workflow engine.
- Editing every possible nested field with a bespoke custom UI in v1; advanced YAML remains available in the YAML panel.
- Running workflows in the browser.
- Replacing existing scheduler behavior.
- Supporting Archon workflow editing beyond read/compatibility display in v1.

## Decisions

### 1. Put graph conversion in `@funny/pipelines`

**Decision:** Add graph conversion helpers to `packages/pipelines`, close to the YAML schema:

- `pipelineToGraph(parsed: ParsedPipeline): WorkflowGraph`
- `graphToPipeline(graph: WorkflowGraph): ParsedPipeline`
- `pipelineToMermaid(parsed: ParsedPipeline): string` as a cheap export/debug path

**Rationale:** The graph shape follows the YAML schema, not runtime services. Keeping it in `@funny/pipelines` makes it testable and reusable by runtime, client, docs, or future visualizers.

### 2. Treat YAML as canonical, graph as projection

**Decision:** The saved artifact remains YAML. The editor maintains a typed `WorkflowDraft` derived from parsed YAML; React Flow positions and viewport state are UI metadata, not required for execution.

**Rationale:** Existing pipeline loading, overrides, and version control already revolve around YAML files. Users can review diffs normally, and the runtime remains compatible with hand-authored workflows.

### 3. Use React Flow with dagre layout

**Decision:** Add `@xyflow/react` and `@dagrejs/dagre` to `packages/client`. Use dagre for initial layout and manual React Flow positions after user edits.

**Rationale:** This matches the existing `evflow` viewer approach and the DBML extension pattern. React Flow gives selection, edges, handles, minimap, controls, and custom node rendering without building graph interaction from scratch.

### 4. Runtime owns filesystem and execution

**Decision:** Add runtime routes for workflow operations:

- `GET /api/workflows/pipelines`
- `GET /api/workflows/pipelines/:name`
- `POST /api/workflows/pipelines/validate`
- `PUT /api/workflows/pipelines/:name`
- `POST /api/workflows/pipelines/:name/dispatch`
- `GET /api/workflows/runs/:pipelineRunId`

These routes call existing loader/parser/compiler/dispatcher services.

**Rationale:** The client should not know repo filesystem layout or execute workflows. Runtime already has repo context, action providers, scheduler adapters, and approval store access.

### 5. Built-ins are read-only until overridden

**Decision:** Built-in YAMLs can be viewed and executed. Editing a built-in pipeline creates a user override at `<repoRoot>/.funny/pipelines/<name>.yaml`.

**Rationale:** This matches current loader precedence and prevents accidental mutation of shipped defaults.

### 6. Represent execution status on graph nodes

**Decision:** Pipeline run events update a node status map:

- `idle`
- `queued`
- `running`
- `completed`
- `failed`
- `skipped`
- `waiting_approval`
- `cancelled`

Edges can highlight when all source dependencies completed.

**Rationale:** Users need to understand not just workflow structure but where a live run is blocked or failing.

## Data Model

### WorkflowGraph

```typescript
interface WorkflowGraph {
  name: string;
  description?: string;
  inputs: Record<string, ParsedInputDef>;
  nodes: WorkflowGraphNode[];
  edges: WorkflowGraphEdge[];
  diagnostics: WorkflowDiagnostic[];
}

interface WorkflowGraphNode {
  id: string;
  action: WorkflowActionKind;
  label: string;
  data: ParsedNode;
  readonly?: boolean;
}

interface WorkflowGraphEdge {
  id: string;
  source: string;
  target: string;
  kind: 'depends_on' | 'loop' | 'pipeline_ref';
  label?: string;
}
```

`depends_on` creates normal dependency edges. `loop.back_to` creates a dashed loop edge. `pipeline:` actions show as a node with a reference badge; expanding referenced pipelines is optional after v1.

## UI Shape

The first screen should be the workflow tool, not a landing page:

- Left rail: workflow list with built-in/user source badges and search.
- Center: React Flow canvas with action-specific node styling, minimap, zoom controls, auto-layout, run-status overlays, and dependency edges.
- Right inspector: selected node form, YAML fragment, validation errors, and delete/duplicate actions.
- Bottom or side panel: full YAML preview/editor, declared inputs, dispatch button, active run status, and logs/events.

The editor should use compact operational styling consistent with the rest of Funny, not a marketing-style surface.

## Validation

Validation happens in two places:

- Client-side draft checks for immediate UX: duplicate IDs, missing action, invalid connection target, self-dependency.
- Runtime validation as the source of truth: parse YAML with `parsePipelineYaml`, compile with `compileYamlPipeline`, and return structured issues.

Unknown YAML fields remain rejected by the existing strict schema.

## Execution Flow

1. User selects a repo/project and workflow.
2. Client loads workflow metadata and graph.
3. User edits graph/forms or YAML.
4. Client validates draft.
5. User saves; runtime writes a user override if needed.
6. User enters declared inputs and clicks run.
7. Runtime dispatches through `SchedulerPipelineDispatcher`.
8. Client receives run state over existing WebSocket events where available and falls back to polling `GET /api/workflows/runs/:pipelineRunId`.
9. Graph updates node statuses and surfaces approvals through the existing approval dialog/store.

## Risks / Trade-offs

- **Graph-to-YAML round trips can reorder comments.** Mitigation: v1 can preserve full-file YAML only when editing via YAML panel; visual edits serialize canonical YAML and warn that comments may be reformatted.
- **Advanced fields can outpace form coverage.** Mitigation: keep YAML panel editable and validate through runtime.
- **Executing arbitrary workflows is powerful.** Mitigation: reuse current runtime permissions and action providers; do not add new action capabilities.
- **Live status mapping may be incomplete initially.** Mitigation: start with engine state changes and progress reporter events, then refine with richer per-node event payloads.
- **React Flow adds client weight.** Mitigation: lazy-load the workflow editor route/panel and import React Flow CSS only there.
