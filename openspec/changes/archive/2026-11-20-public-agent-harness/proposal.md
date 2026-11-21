## Why

funny has the core pieces of a Flue-like framework, but they are exposed as
internal product services: agent processes live in `@funny/core`, workflows live
in `@funny/pipelines`, runtime actions live behind `ActionProvider`, and sandbox
execution is split between process-level Podman isolation and the planned
cloud-runner model. This change creates a small public harness API so users can
author agents, sessions, tools, workflows, and sandbox intent without importing
the full funny server/runtime product.

## What Changes

- Add a new public package, `@funny/harness`, that exposes stable authoring APIs:
  `createAgent`, `createSession`, `defineTool`, `defineWorkflow`, and
  `runWorkflow`.
- Introduce harness-level execution abstractions that map to existing funny
  internals instead of creating a second workflow or agent engine.
- Provide a sandbox selection surface that distinguishes local execution,
  process-level agent isolation, and whole-runner sandbox execution.
- Keep provider SDKs and cloud lifecycle policy out of the harness. Infrastructure provider
  remain behind the `RunnerInfraProvider` and provisioner work from the
  `provision-railway-runners` change.
- Add examples and tests showing direct agent prompting, tool registration,
  workflow execution, and sandbox backend selection.

## Capabilities

### New Capabilities

- `agent-harness`: Public agent/workflow harness API for defining agents, tools,
  sessions, workflows, and sandbox execution intent over the existing funny core
  and pipeline engines.

### Modified Capabilities

None. This change integrates with the active `provision-railway-runners` change but
does not change its provider lifecycle requirements.

## Impact

- **New package:** `packages/harness` with public exports and focused tests.
- **Core APIs:** Reuses `@funny/core` agent process/provider primitives and may
  add small type exports where needed.
- **Pipeline APIs:** Reuses `@funny/pipelines` for workflow execution rather than
  introducing another workflow engine.
- **Runtime/server integration:** Provides adapters so the existing runtime
  `ActionProvider` and future cloud runner provisioner can satisfy harness
  execution requests.
- **Sandbox model:** Adds a public sandbox-intent API that can target local
  execution, current process-level sandboxing, or the future
  `provision-railway-runners` whole-runner backend.
- **Docs/tests:** Adds package README/examples plus unit tests for API shape,
  adapter behavior, and sandbox selection.
