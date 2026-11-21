## Context

The current system has three concepts collapsed under "pipeline":

1. `@funny/pipelines` - generic execution engine with nodes, DAG dependencies, loops,
   retry, guards, and `runPipeline()`.
2. Runtime YAML files - user-facing workflow definitions that declare actions like
   `spawn_agent`, `git_commit`, `approval`, `set_status`, and `pipeline`.
3. Runtime execution adapters - action providers that bind those workflow actions to
   live Funny services.

The new direction separates these concerns:

```text
@funny/pipelines
  generic execution engine

@funny/workflows
  versioned workflow YAML format
  built-in workflow catalog
  YAML parser/validator/serializer
  YAML <-> React Flow graph model

@ironmussa/funny-runtime
  runtime action providers
  workflow-to-pipeline compiler
  scheduler dispatch and cancellation
```

The client should edit workflow YAML as project files so changes can be versioned,
reviewed, reverted, and copied between repositories.

## Goals / Non-Goals

**Goals:**

- Make workflow YAML a versioned project artifact under `.funny/workflows/*.yaml`.
- Move built-in workflow YAML out of runtime into `@funny/workflows`.
- Keep `@funny/pipelines` as a generic engine rather than the owner of Funny workflow
  YAML actions.
- Provide a React Flow designer that can visualize and edit workflow nodes and
  dependencies.
- Preserve hand-editability: saved output remains normal YAML, not a hidden graph format.
- Allow execution from the designer using the existing scheduler dispatcher path.
- Show validation diagnostics before save and run.
- Show live per-node run state in the designer.
- Make the old `.funny/pipelines` path unsupported for this system.

**Non-Goals:**

- No compatibility reader for `.funny/pipelines/*.yaml`.
- No automatic migration of existing `.funny/pipelines` files.
- No DB-backed workflow source of truth.
- No collaborative multi-user graph editing in this change.
- No full visual diff between built-ins and overrides in the MVP.
- No support for every possible free-form YAML edit through visual controls. Advanced
  YAML can still be edited in source view and validated.

## Architecture

```text
packages/workflows
  defaults/*.yaml
  src/schema.ts
  src/parse.ts
  src/serialize.ts
  src/graph.ts
  src/catalog.ts

packages/runtime
  workflow-loader.ts
  workflow-compiler.ts
  routes/workflows.ts
  scheduler-pipeline-adapters.ts

packages/client
  WorkflowDesigner
  WorkflowGraph
  WorkflowInspector
  WorkflowSourcePanel
  WorkflowRunPanel
```

The runtime keeps the compiler because compiling a workflow action to executable
behavior needs runtime services and action providers. The workflow package owns the
validated data model, graph representation, and built-ins.

## Decisions

### 1. YAML is the source of truth

**Decision:** The graph editor reads YAML into a typed workflow model, converts it to
React Flow nodes/edges for interaction, then serializes the edited model back to YAML.

**Rationale:** YAML files are versionable and reviewable. React Flow is an editing view,
not a separate persistence format.

### 2. Clean workflow path break

**Decision:** Project workflows live only at `<repo>/.funny/workflows/*.yaml`.
Built-ins live only in `packages/workflows/defaults/*.yaml`.

**Rationale:** The old path encodes the runtime implementation detail. Keeping aliases
would preserve the confusing model and create ongoing loader complexity.

### 3. `@funny/workflows` owns workflow format, not execution

**Decision:** `@funny/workflows` owns schema, parse, serialize, graph conversion, and
built-in YAML. Runtime owns action binding and compilation to `PipelineDefinition`.

**Rationale:** Client and tests need workflow metadata without importing runtime. Runtime
still needs to bind actions like `spawn_agent` to live services.

### 4. Built-ins are read-only until overridden

**Decision:** Built-in workflows are visible in the designer but read-only. Editing a
built-in creates or updates a project override in `.funny/workflows/<name>.yaml`.

**Rationale:** This matches the existing override model while making the write target
explicit and versionable.

### 5. Visual editor is structured, source editor remains available

**Decision:** The MVP visual editor supports common fields directly: id, action type,
action config JSON/YAML, `depends_on`, `when`, `on_error`, retry, and loop settings.
The source panel remains available for advanced edits.

**Rationale:** Trying to visually model every action-specific nested field up front
would slow the change and still need source escape hatches.

### 6. Run state maps to node ids

**Decision:** Runtime progress events should include workflow name, run id, node id,
status, and optional metadata. The client stores this by run id and maps it onto React
Flow node ids.

**Rationale:** The designer needs node-level highlighting without parsing message text
or inferring state from thread events.

## API Shape

Runtime/server-facing DTOs should be shared through `@funny/shared`:

```text
WorkflowSummary
  name
  description
  source: built-in | user
  filePath?
  hasOverride

WorkflowDefinitionResponse
  summary
  yaml
  parsed
  graph
  diagnostics

WorkflowSaveRequest
  name
  yaml

WorkflowRunRequest
  threadId
  workflowName
  prompt?
  inputs?

WorkflowNodeRunState
  runId
  workflowName
  nodeId
  status: pending | running | completed | skipped | failed | waiting_approval
  message?
  metadata?
```

Suggested routes:

```text
GET  /api/workflows?projectId=<id>
GET  /api/workflows/:name?projectId=<id>
POST /api/workflows/validate
PUT  /api/workflows/:name
POST /api/workflows/:name/run
POST /api/workflows/runs/:runId/cancel
```

The run route can delegate to the existing scheduler dispatch route internally, but
the UI should speak workflow terminology.

## Graph Model

`@funny/workflows` should expose a React Flow neutral graph type:

```text
WorkflowGraph
  nodes:
    id
    type: workflowNode
    position
    data:
      label
      actionType
      description?
      when?
      onError
      retry?
      loop?
      sourceNode
  edges:
    id
    source
    target
    label?
    kind: dependency | loop | subworkflow
```

Conversion rules:

- `depends_on` creates dependency edges from each dependency to the node.
- A node without `depends_on` is a root.
- `loop.back_to` creates a loop edge from the loop node to the target. If omitted,
  it creates a self-loop.
- `pipeline.name` creates metadata for a subworkflow node. Expanding nested
  subworkflow graphs is deferred.
- `when`, `retry`, `on_error`, and `approval` fields are represented as node badges
  and inspector fields.

## Risks / Trade-offs

- **Breaking existing local overrides** - Projects with `.funny/pipelines` files stop
  being discovered. This is intentional per product direction. Mitigation: document
  the new path clearly in release notes and validation errors.
- **Runtime routes need project file access** - Saving workflow YAML writes into the
  selected project checkout. Mitigation: reuse existing project path resolution and
  server-to-runner proxy patterns, with ownership checks before writes.
- **Graph edits can create invalid YAML** - The designer should run schema validation
  after every edit and block save/run while errors exist.
- **Action config editing can become large** - Use a structured inspector for common
  fields and a source panel for full YAML.
- **Naming collision with existing PipelineSettings** - Keep the new UI named
  Workflows. Do not overload the current DB-backed pipeline settings panel.
