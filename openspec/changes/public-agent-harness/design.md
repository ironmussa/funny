## Context

funny already has the pieces needed for a framework-style agent runtime, but
they sit at different product layers:

- `@funny/core` owns provider-agnostic agent process interfaces and concrete
  process implementations.
- `@funny/pipelines` owns a generic pipeline engine that intentionally knows
  nothing about agents, git, commands, or UI.
- `packages/runtime/src/pipelines` adds a product-specific `ActionProvider`
  contract and `PipelineRunner`.
- `packages/core/src/containers/SandboxManager` sandboxes the agent subprocess
  by redirecting Claude Code process creation into Podman.
- The active `provision-railway-runners` change introduces a different sandbox
  altitude: whole dedicated runners provisioned on remote infrastructure (Railway first) behind `RunnerInfraProvider`.

The harness should be the public authoring/runtime facade over these pieces,
not another implementation of agents, workflows, or sandbox lifecycle.

```
                 user code
                    │
                    ▼
             @funny/harness
     ┌──────────┬───────────┬──────────┐
     │ agents   │ workflows │ tools    │
     └────┬─────┴─────┬─────┴────┬─────┘
          │           │          │
          ▼           ▼          ▼
   @funny/core   @funny/pipelines   tool registry/MCP adapter
          │           │
          └─────┬─────┘
                ▼
       HarnessRuntime adapter
                │
      ┌─────────┴───────────┐
      ▼                     ▼
 local/process runtime   server/runtime provisioner
 SandboxManager          provision-railway-runners
```

### Sandbox altitudes

The harness has to preserve a distinction that is easy to blur:

- **Local execution**: agent/workflow runs on the current host.
- **Process sandbox**: only the agent subprocess is sandboxed. This maps to the
  current `SandboxManager`/`spawnClaudeCodeProcess` hook.
- **Runner sandbox**: the entire funny runner is provisioned in an isolated
  environment. This maps to `provision-railway-runners` and its
  `RunnerInfraProvider`.

## Goals / Non-Goals

**Goals:**

- Provide a small, stable TypeScript API for defining agents, sessions, tools,
  workflows, and sandbox intent.
- Reuse `@funny/core` for agent execution and `@funny/pipelines` for workflow
  execution.
- Let product runtime/server code plug in via adapters instead of making
  `@funny/harness` depend on the full Hono/DB/WebSocket app.
- Model sandbox selection clearly enough to target local, process-level, and
  whole-runner execution.
- Integrate with `provision-railway-runners` by delegating runner-sandbox lifecycle
  to the provisioner and provider seam.
- Ship tests and examples that make the public API hard to regress.

**Non-Goals:**

- Replacing the funny server, thread UI, DB schema, or runner protocol.
- Implementing infrastructure-provider (e.g. Railway) or remote-runner lifecycle policy inside the harness package.
- Creating a new workflow engine.
- Making every current runtime action available in the first public API.
- Reworking existing product pipelines unless needed to add an adapter.
- Retiring `SandboxManager`; process-level sandboxing remains a valid backend.

## Decisions

### D1. Add `packages/harness` as the public facade package

`@funny/harness` will expose the framework surface:

```ts
import {
  createAgent,
  createSession,
  defineTool,
  defineWorkflow,
  runWorkflow,
  sandbox,
} from '@funny/harness';
```

The package should keep dependencies light: `@funny/core`, `@funny/pipelines`,
`@funny/shared` where needed, and validation utilities already used in the repo.
It should not import `packages/runtime` or `packages/server`.

**Alternative considered:** put the API in `@funny/core`. Rejected because
`core` is already the low-level agent/process layer; mixing public authoring
ergonomics into it would make the boundary less clear.

### D2. Define agents as declarative specs, execute through sessions

`createAgent()` returns an agent definition: provider/model, instructions,
permission mode, tool policy, MCP/tool registrations, and sandbox intent.
`createSession()` binds an agent to a runtime, cwd, and optional persisted
session id. `session.prompt()` is the primary execution method and returns a
normalized result while also exposing streamed events.

This mirrors the way `@funny/core` already separates process options from the
process implementation, while giving users a smaller surface than
`ClaudeProcessOptions`.

**Alternative considered:** make `createAgent().prompt()` spawn directly. That
is convenient for one-shot calls, but it hides session reuse, steering, tool
state, and future persistence. The harness can still offer `agent.prompt()` as a
thin convenience over `createSession()`.

### D3. Keep workflows on `@funny/pipelines`

`defineWorkflow()` will create a typed workflow definition that compiles to, or
directly wraps, `@funny/pipelines` definitions. Workflow context includes a
runtime adapter, progress reporter, tools, cwd, and session factory.

The harness may provide a function-style authoring layer for ergonomics, but the
execution path remains the existing pipeline engine.

**Alternative considered:** introduce a new async-function workflow engine.
Rejected because it would duplicate cancellation, progress, guard/loop, and test
behavior already handled by `@funny/pipelines`.

### D4. Introduce a small `HarnessRuntime` adapter contract

The harness should depend on a runtime interface, not on product services:

```ts
interface HarnessRuntime {
  spawnAgent(request: HarnessAgentRequest): Promise<HarnessAgentResult>;
  runCommand?(request: HarnessCommandRequest): Promise<HarnessCommandResult>;
  requestApproval?(request: HarnessApprovalRequest): Promise<HarnessApprovalDecision>;
  notify?(event: HarnessEvent): void | Promise<void>;
  resolveSandbox?(request: SandboxExecutionRequest): Promise<SandboxExecutionHandle>;
}
```

Implementations:

- **Local runtime adapter:** uses `@funny/core` processes directly.
- **Runtime/server adapter:** wraps existing `RuntimeActionProvider` and thread
  services.
- **Test adapter:** deterministic fake for unit tests and examples.

This contract also gives product code a migration path: existing runtime
pipelines can continue using `ActionProvider`, while harness workflows use an
adapter that bridges to it.

**Alternative considered:** export the current runtime `ActionProvider` as the
harness contract. Rejected because it is product-shaped: git commits, thread
status/stage, PR creation, and approvals are useful actions, but they should not
be the minimum contract for a general harness.

### D5. Tools are portable definitions plus adapters

`defineTool()` should capture name, description, input schema, and handler. The
harness owns validation and registration rules. Runtimes decide how tools become
available:

- Workflows can invoke registered tools directly.
- Agent sessions can expose tools through an MCP adapter where the provider
  supports MCP/tool surfaces.
- Runtimes that cannot expose dynamic tools must fail clearly at session start.

**Alternative considered:** treat tools only as Claude Code allow-list names.
Rejected because that does not provide custom tool handlers or typed inputs.

### D6. Model sandbox intent separately from provider mechanics

The harness exports constructors like:

```ts
sandbox.local();
sandbox.process({ isolation: 'podman' });
sandbox.runner({ provider: 'default' });
```

These produce intent objects. They do not start containers or call cloud SDKs.

- `local` means no sandbox boundary beyond the current process.
- `process` asks the runtime to sandbox the agent subprocess, mapping to
  `SandboxManager` when available.
- `runner` asks the runtime/server to execute through a whole-runner backend,
  mapping to `provision-railway-runners`.

`runner` sandbox execution must not import infrastructure provider SDKs/APIs or call
`RunnerInfraProvider` directly from `@funny/harness`. The server-side provisioner
selects the provider, applies capability-aware lifecycle policy, and handles
keys.

**Alternative considered:** put `RunnerInfraProvider` implementations behind
`@funny/harness/sandbox`. Rejected because provider credentials, lifecycle,
thread mapping, and billing behavior belong to the server/provisioner layer.

### D7. Normalize events and errors at the harness boundary

The harness should expose a small event stream covering session lifecycle,
messages, tool calls, progress, sandbox resolution, and completion. Errors
should include stable codes such as `runtime_unavailable`,
`unsupported_sandbox_backend`, `tool_validation_failed`, and
`agent_execution_failed`.

This keeps examples and consumers independent of provider-specific message
shapes while still allowing raw events in metadata when needed.

### D8. Keep publishing and migration incremental

The first implementation can be a workspace package with stable exports and
tests. Publishing to npm can happen after API review without changing the
contract. Existing runtime and product flows remain untouched until adapters are
opted in.

## Risks / Trade-offs

- **API freezes too early** -> Mark the package as experimental in docs until
  examples cover direct prompts, tools, workflows, and sandbox backends.
- **Harness leaks product concepts** -> Keep `HarnessRuntime` minimal and move
  git/thread-specific helpers behind optional extensions.
- **Tool exposure differs by provider** -> Require runtimes to declare tool
  exposure capabilities and fail before starting an agent if unsupported.
- **Sandbox naming causes confusion** -> Document the three altitudes and make
  `process` vs `runner` explicit in type names and examples.
- **Cloud sandbox work races this change** -> Depend only on the abstract
  runner-sandbox intent; integrate with `provision-railway-runners` once its
  provisioner seam lands.
- **Duplicate action contracts** -> Add a focused adapter between harness
  runtime requests and existing `ActionProvider` instead of rewriting existing
  product pipelines.

## Migration Plan

1. Add `packages/harness` with types, public exports, and fake/test runtime.
2. Implement local agent sessions over `@funny/core`.
3. Implement workflow execution over `@funny/pipelines`.
4. Add tool registry and direct workflow invocation.
5. Add MCP/tool exposure adapter for agent sessions where supported.
6. Add runtime/server adapter that bridges to existing `ActionProvider`.
7. Add sandbox intent handling for `local` and `process`.
8. Add `runner` sandbox intent adapter once `provision-railway-runners` provides the
   server-side provisioner.
9. Add README/examples, then review whether to publish as a non-private package.

Rollback is straightforward before product code adopts the package: remove the
new workspace package and examples. After adoption, consumers can fall back to
the previous direct runtime/core imports because this change does not remove
existing APIs.

## Open Questions

- Should the package name be `@funny/harness` or
  `@funny/agent-runtime` before npm publication?
- Should custom tool exposure initially require MCP, or should the harness also
  support provider-specific native tool APIs where available?
- How much of the existing runtime `ActionProvider` should be promoted into a
  shared optional extension versus staying product-specific?
