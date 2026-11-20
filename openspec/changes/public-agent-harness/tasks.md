## 1. Package Scaffold

- [x] 1.1 Create `packages/harness` with `package.json`, `tsconfig.json`, `src/index.ts`, and test configuration matching existing workspace package patterns.
- [x] 1.2 Add `@funny/harness` to workspace build/typecheck/test coverage without changing existing package behavior.
- [x] 1.3 Define public export groups for agents, sessions, tools, workflows, runtime adapters, sandbox intent, events, and errors.
- [x] 1.4 Add package boundary tests that assert `@funny/harness` resolves public exports and does not import `packages/server` or `@ironmussa/funny-runtime`.

## 2. Core Harness Types

- [x] 2.1 Define `HarnessRuntime`, `HarnessAgentRequest`, `HarnessAgentResult`, command, approval, notification, and sandbox resolution request/result types.
- [x] 2.2 Define normalized `HarnessEvent` and `HarnessError` types with stable error codes.
- [x] 2.3 Define agent option types that normalize provider, model, instructions, permission mode, tool policy, MCP/tool registrations, cwd, and sandbox intent.
- [x] 2.4 Add type-level and runtime validation tests for invalid agent/runtime/sandbox inputs.

## 3. Agent Definitions and Sessions

- [x] 3.1 Implement `createAgent` as an immutable declarative agent definition factory.
- [x] 3.2 Implement `createSession` to bind an agent to a runtime, cwd, optional persisted provider session id, and optional event sink.
- [x] 3.3 Implement `session.prompt` to delegate to `HarnessRuntime.spawnAgent`, return normalized results, and forward normalized events.
- [x] 3.4 Add support for provider session continuation by passing an existing provider session id through the runtime request.
- [x] 3.5 Add tests for direct prompting, continuation, event streaming, failure normalization, and immutable agent definitions.

## 4. Local Runtime Adapter

- [x] 4.1 Implement a local runtime adapter that creates agent processes through `@funny/core` interfaces.
- [x] 4.2 Map harness agent options to existing `AgentProcessOptions`/`ClaudeProcessOptions` without exposing the full low-level option surface publicly.
- [x] 4.3 Normalize core CLI messages into harness session events and result objects.
- [x] 4.4 Add fake-process tests for success, provider errors, process exit, cancellation, and provider session id propagation.

## 5. Tool Registry

- [x] 5.1 Implement `defineTool` with name, description, input schema, handler, and inferred TypeScript input/output types.
- [x] 5.2 Implement a tool registry that rejects duplicate tool names and validates input before handler invocation.
- [x] 5.3 Add direct tool invocation APIs for workflow contexts.
- [x] 5.4 Add an agent tool exposure adapter surface so runtimes can expose registered tools through MCP or fail before agent start when unsupported.
- [x] 5.5 Add tests for schema validation, duplicate names, successful invocation, handler errors, and unsupported agent tool exposure.

## 6. Workflow Harness

- [x] 6.1 Implement `defineWorkflow` as the public workflow authoring API backed by `@funny/pipelines`.
- [x] 6.2 Implement `runWorkflow` to build pipeline context with cwd, runtime, progress reporter, tool registry, and session factory.
- [x] 6.3 Bridge workflow progress, failure, retry, skipped, completion, and cancellation events to stable harness results.
- [x] 6.4 Add tests for successful workflow execution, tool-backed steps, agent-session steps, progress reporting, cancellation, and runtime capability failures.

## 7. Runtime ActionProvider Bridge

- [x] 7.1 Implement an adapter that maps harness runtime requests to the existing runtime `ActionProvider` shape for product integration.
- [x] 7.2 Keep the bridge outside the harness package core path if importing runtime-only types would pull in server/runtime dependencies.
- [x] 7.3 Add tests with a fake `ActionProvider` for spawn-agent, command, approval, notify, and failure mapping.
- [x] 7.4 Document which `ActionProvider` operations are product-specific extensions rather than required harness capabilities.

## 8. Sandbox Intent

- [x] 8.1 Implement `sandbox.local()`, process-level sandbox intent, and runner-level sandbox intent constructors.
- [x] 8.2 Add runtime capability checks so unsupported sandbox backends fail with `unsupported_sandbox_backend` before work starts.
- [x] 8.3 Implement process-level sandbox mapping for runtimes that can supply the existing `SandboxManager` spawn hook.
- [x] 8.4 Define the runner-level sandbox request shape used by server/runtime adapters without importing infrastructure provider SDKs.
- [x] 8.5 Add tests for local execution, process sandbox mapping, runner sandbox request delegation, and unsupported backend errors.

## 9. Cloud Sandbox Integration Boundary

- [x] 9.1 Document that runner-level sandbox intent integrates with the `provision-railway-runners` `RunnerInfraProvider` once available.
- [x] 9.2 Add adapter tests proving runner-level intent delegates to a provisioner-like capability rather than constructing provider clients.
- [x] 9.3 Ensure provider selection, provider keys, pause/resume, snapshot, restore, idle lifecycle, and billing behavior remain outside `@funny/harness`.
- [x] 9.4 Add a compatibility note linking the harness runner-sandbox intent to the `provision-railway-runners` `RunnerInfraProvider` seam.

## 10. Examples and Documentation

- [x] 10.1 Add README examples for direct agent prompting, session continuation, custom tools, workflow execution, and sandbox backend selection.
- [x] 10.2 Add a sandbox-altitude diagram explaining local vs process-level vs whole-runner sandbox execution.
- [x] 10.3 Add a minimal example using the fake/test runtime so examples can run without provider credentials.
- [x] 10.4 Add notes describing the experimental API status and the package naming decision before npm publication.

## 11. Verification

- [x] 11.1 Run `bun run --cwd packages/harness test`.
- [x] 11.2 Run workspace typecheck for packages affected by harness exports and adapters.
- [x] 11.3 Run focused runtime/core tests touched by adapter work.
- [x] 11.4 Run `openspec status --change "public-agent-harness"` and confirm the change is apply-ready.
