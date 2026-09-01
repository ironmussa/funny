# How a live agent run actually executes

This traces what happens when a user sends a message to a thread in the running app (client + server + runner) — as opposed to the standalone issue-to-PR automation covered in [integrations/extensions-and-services.md](../integrations/extensions-and-services.md). Everything on this page lives in `packages/runtime`, `packages/core`, `packages/shared`, and `packages/client`; none of `packages/agent`, `packages/api-acp`, or `packages/harness` participate in it.

## Sequence

```mermaid
sequenceDiagram
    participant Client as packages/client
    participant Server as packages/server (coordinator)
    participant Runtime as packages/runtime (runner)
    participant Orchestrator as core/agents/orchestrator.ts<br/>(AgentOrchestrator)
    participant Process as provider process<br/>(sdk-claude.ts / *-acp.ts / llm-api-process.ts)

    Client->>Server: POST /api/threads/:id/message
    Server->>Server: HTTP handler calls RunnerRequestPort
    Server->>Runtime: framed operation over authenticated runner.v2 gRPC
    Runtime->>Runtime: services/thread-service/messaging.ts, thread-manager.ts
    Runtime->>Orchestrator: agent-runner.ts instantiates AgentOrchestrator
    Orchestrator->>Process: process-factory.ts picks provider class, spawns subprocess
    Process-->>Orchestrator: streamed events (assistant text, tool calls, tokens)
    Orchestrator-->>Runtime: agent-event-router.ts
    Runtime->>Runtime: agent-lifecycle.ts / agent-state.ts / agent-message-handler.ts persist state
    Runtime->>Runtime: ws-broker.ts broadcasts
    Runtime-->>Server: RunnerEventPublisher streams event over runner.v2 gRPC
    Server->>Server: BrowserEventSink selects owner/sharee rooms
    Server-->>Client: Socket.IO event (agent:message / agent:status / agent:tool_call), filtered per user
```

## Step by step, with files

1. **Client → Server.** The client sends a follow-up or new message through the REST API; `packages/server` is the single entry point for all client requests and owns persistent state (users, projects, threads, messages).
2. **Server → Runner.** Presentation code asks `RunnerRequestPort` for the user-scoped runner; `GrpcRunnerRequestAdapter` translates that transport-neutral request into the framed tunnel stream. **This routing is a hard security boundary** — a request is never routed to a different user's runner, even if that runner happens to be online. The one deliberate exception is _steer-share delegation_ (see [domain/threads-and-worktrees.md](../domain/threads-and-worktrees.md)), which crosses this boundary only through a fixed route allow-list in `packages/server/src/middleware/proxy.ts`.
3. **Runner receives the request.** `packages/runtime/src/services/thread-service/messaging.ts` and `thread-manager.ts` handle the incoming message.
4. **Agent process is spawned.** `packages/runtime/src/services/agent-runner.ts` imports `AgentOrchestrator` and `defaultProcessFactory` directly from `@funny/core/agents` (`packages/core/src/agents/orchestrator.ts` — described in its own docstring as a "portable agent lifecycle manager" that owns process creation and start/stop/resume).
5. **Provider selection.** `AgentOrchestrator` asks `process-factory.ts` for a concrete process implementation based on the thread's configured provider: `sdk-claude.ts` for Claude, `codex-acp.ts` / `gemini-acp.ts` / `cursor-acp.ts` / `opencode-acp.ts` / `generic-acp.ts` for Agent-Client-Protocol CLIs, `deepagent-process.ts`, or `llm/llm-api-process.ts` for generic LLM-API providers. `generic-acp.ts` resolves its spawn command from `packages/shared/src/provider-manifest*.ts` (the pluggable provider-config system).
6. **Events flow back.** The spawned process streams assistant text, tool calls, and token counts through `agent-event-router.ts`. `RunnerEventPublisher` sends them over the event stream; the server accepts/persists each event once and publishes it through `BrowserEventSink`. The Socket.IO adapter targets the owner's user room and shared-thread stream rooms without coupling the event handler to Socket.IO. Every event carries a `threadId` so the client can route it to the right view.
7. **Terminal sessions** are a separate path: `pty-manager.ts` dispatches to one of several backends (`pty-backend-headless.ts`, `pty-backend-bun.ts`, `pty-backend-node-pty.ts`, `pty-backend-tmux.ts`, `pty-backend-daemon.ts`, `pty-backend-null.ts`) depending on platform/availability.
8. **Scheduled/triggered runs** go through `automation-manager.ts` / `automation-scheduler.ts` instead of a direct user message, and can invoke the pipeline layer described in [pipelines-and-automation.md](./pipelines-and-automation.md) for multi-step workflows.

## Thread modes and git operations

- **`local` mode** runs the agent directly in the project directory; **`worktree` mode** creates an isolated git worktree + branch per thread (`packages/core/src/git/worktree.ts`).
- All git operations funnel through `packages/core/src/git/process.ts` (`gitRead`/`gitWrite` concurrency pools, `execute` for general process spawning) — this is the one place cross-platform process execution and pooling happens.
- `packages/core/src/git/git.ts` holds the high-level operations (diff, stage, commit, push, branch management); `packages/core/src/git/github.ts` wraps the `gh` CLI for PRs.
- `packages/core/src/git/native.ts` optionally loads `@funny/native-git` (the Rust/`gitoxide` module) to accelerate status/diff/log/blame, falling back to the CLI-based path when the native addon isn't available for the current platform — parity between the two is checked by `packages/core/src/__tests__/git-native-parity.test.ts`.

## What changed vs. `CLAUDE.md`

`CLAUDE.md`'s description of agent-runner → core/agents, runner isolation, and git through `core/git/process.ts` remains accurate. Its direct WebSocket runner transport is obsolete: the local broker feeds the runtime's gRPC event adapter, while browsers still receive Socket.IO from the central server. The other addition it is silent on: `packages/runtime/src/services/pipeline-manager.ts` now delegates DAG execution to `@funny/pipelines`' `runPipeline` while keeping domain-specific glue (agent/git/approval actions) locally — see [pipelines-and-automation.md](./pipelines-and-automation.md).
