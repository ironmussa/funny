# Agent Pipeline: Distributed Software Quality System

## Executive Summary

This document defines a **Pipeline Service** — an independent software quality service based on AI agents. The Service exposes a REST API. Any web service, CLI, or external system can make HTTP requests to send worktrees for processing. The Service handles everything: receiving the branch, running 8 quality agents in parallel, auto-correcting issues, and notifying results via webhooks.

The architecture follows the **Hexagonal (Ports & Adapters)** pattern. The Core defines clear input and output contracts. The Service encapsulates all the complexity — adapters, Event Bus, Director, Integrator — in a single process. External clients don't spawn processes, don't manage agents, don't know how it works internally.

A Director Agent coordinates multiple simultaneous pipelines. An Integration Agent takes approved branches, creates Pull Requests toward main with a complete summary of results, resolves conflicts, and deduplicates code. The final merge to main requires human approval via PR.

The fundamental difference from a traditional CI/CD: **this system doesn't just detect problems, it fixes them. And it doesn't just fix one — it coordinates many in parallel. And it's not coupled to any tool — it connects to anything.**

---

## 1. General Architecture: Pipeline Service

The complete system is a **Pipeline Service** — an independent service that runs on its own. Any web service can send worktrees to process via HTTP. It doesn't spawn processes, doesn't manage agents, doesn't know how the pipeline works internally. It just sends a request and receives notifications.

```
┌───────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                                                                                   │
│                              PIPELINE SERVICE (independent service)                                │
│                              Runs on its own. Nobody "starts" it per request.                     │
│                                                                                                   │
│   ┌─────────────────┐     ┌───────────────────────────────┐     ┌──────────────────────────────┐  │
│   │ INBOUND          │     │                               │     │ OUTBOUND                      │  │
│   │                  │     │       PIPELINE CORE            │     │                              │  │
│   │ REST API         │     │                               │     │  Manifest Writer             │  │
│   │ POST /pipeline   │────►│  Receives PipelineRequest     │────►│  Webhook Notifier → HTTP POST│───► Client
│   │ POST /director   │     │  Classifies tier              │     │  Slack Notifier  → Webhook   │───► Slack
│   │                  │     │  Starts containers (Step 0)   │     │  GitHub Notifier → gh API    │───► GitHub
│   │ CLI              │     │  Creates browser (Playwright) │     │                              │  │
│   │ pipeline run ... │────►│  Creates pipeline/ branch     │     │                              │  │
│   │                  │     │  Runs 8 agents (with browser) │     │                              │  │
│   │ MCP Server       │     │  Auto-corrects                │     │  Only reacts to events       │  │
│   │ tool: run_pipe.. │────►│  Emits PipelineEvent[]        │     │  Doesn't know what Core is   │  │
│   │                  │     │                               │     │                              │  │
│   └─────────────────┘     └───────────────┬───────────────┘     └──────────────────────────────┘  │
│                                            │                                                      │
│                                      ┌─────┴─────┐                                                │
│                                      │ EVENT BUS │                                                │
│                                      │           │                                                │
│                                      │ Connects  │                                                │
│                                      │ Core with │                                                │
│                                      │ Outbound  │                                                │
│                                      └───────────┘                                                │
│                                                                                                   │
│   ┌─────────────────┐     ┌──────────────────────────┐     ┌──────────────────────────────────┐   │
│   │ DIRECTOR         │     │ INTEGRATOR               │     │ INFRASTRUCTURE                    │   │
│   │                  │     │                          │     │                                  │   │
│   │ Reads manifest   │────►│ Creates PR toward main   │     │  SandboxManager (Podman, REQ.)   │   │
│   │ Reacts to        │     │ Resolves conflicts       │     │  ContainerService (compose, OPT.)│   │
│   │ events           │     │ Deduplicates             │     │  CDP Browser (Playwright)        │   │
│   └─────────────────┘     └──────────────────────────┘     │  Circuit Breakers, DLQ, Idem.    │   │
│                                                             └──────────────────────────────────┘   │
│                                                                                                   │
└───────────────────────────────────────────────────────────────────────────────────────────────────┘

        ▲                         ▲                         ▲
        │ HTTP POST               │ HTTP POST               │ Webhook
        │ (fire & forget)         │ (fire & forget)         │ (receives events)
        │                         │                         │
   Web service               GitHub                   Slack / Jira / etc.
   (any)                     (webhooks)               (receive notifications)
```

### The Pipeline Service is autonomous

The Pipeline Service:

- **Runs as a service** — It starts once, listens for requests. It's not "spawned per request".
- **Exposes a REST API** — External clients just make HTTP POST. They receive `202 Accepted` and that's it.
- **Manages everything internally** — Adapters, Core, Event Bus, Director, Integrator, Containers, Browser. Everything lives inside.
- **Starts mandatory infrastructure** — **Always** creates a Podman sandbox container for each pipeline (mandatory requirement — without Podman the pipeline fails). The worktree files are copied to the container and a fresh git repo is initialized. Additionally, if the project has a `compose.yml`, it starts project containers and a browser (Playwright CDP). If there's no compose, it continues without project containers but the sandbox always exists.
- **Notifies via outbound** — When something happens, the outbound adapters call registered clients via webhooks.

### What an external client needs to do

| Client              | To trigger                                                  | To receive results                          |
| ------------------- | ----------------------------------------------------------- | ------------------------------------------- |
| **Any web service** | `POST /pipeline/run` with branch + worktree_path + metadata | Expose a webhook endpoint to receive events |
| **GitHub**          | Configure webhook pointing to the Pipeline Service          | The Service comments on PRs automatically   |
| **CLI**             | `pipeline run --branch feature/auth`                        | See the output in the terminal              |
| **Another agent**   | MCP tool `run_pipeline`                                     | Receives result via MCP                     |

**No client spawns processes, manages agents, or knows how the pipeline works.** They just make HTTP requests and expose endpoints to receive notifications.

### Why this architecture

1. **Independence** — The Service is an autonomous process. Clients don't need to have Claude Code installed, nor know about agents, nor about Git.
2. **Simplicity for clients** — A web service just makes a POST and exposes an endpoint for webhooks. Nothing more.
3. **Extensibility** — Adding a new notification destination (Discord, Jira, email) means adding an outbound adapter inside the Service. Zero changes to the Core, zero changes to existing clients.
4. **Testability** — The Service is tested as a normal HTTP service. Clients are tested independently.
5. **Deployment** — A single service to deploy. Clients don't change their infrastructure.

---

## 2. The Four Levels of the System

### Level 0: Pipeline Service (HTTP API)

The Pipeline Service is an HTTP server that runs permanently. It exposes a REST API that any client can call. A web service makes `POST /pipeline/run` with the worktree data to process and receives notifications via webhooks or SSE. It doesn't spawn anything, doesn't manage anything.

### Level 1: Pipeline Core (Infrastructure + Execution + Validation)

Inside the Service, the Core receives a `PipelineRequest`, classifies the tier of the change, and executes a **Step 0 for infrastructure**: **always** creates a Podman sandbox container where the agent runs (mandatory requirement). The worktree files are copied to the container and a fresh git repository is initialized via `git clone --no-checkout`. Optionally, if the worktree has a `compose.yml`, it also starts project containers, waits for health checks, and creates a headless browser (Playwright CDP) with MCP tools (`cdp_navigate`, `cdp_screenshot`, `cdp_get_dom`). Then it creates the pipeline branch (`pipeline/{branch}`), runs the 8 quality agents in parallel — with browser access if there are project containers — auto-corrects if necessary, and emits events with the results (including `pipeline.cli_message` with each raw agent message for UI rendering). Upon completion, it cleans up sandbox, project containers, and browser. It is completely stateless — it doesn't keep state between executions.

### Level 2: Director (Coordination)

The Director reads the manifest (`.pipeline/manifest.json`) to know which branches are ready. It reacts to `pipeline.completed` events to know when there's new work. It resolves dependencies between branches, orders by priority, and dispatches to the Integrator.

### Level 3: Integrator (Merge)

The Integrator takes approved branches and **creates Pull Requests toward main**. It prepares the branch, resolves conflicts semantically, deduplicates code, re-runs the pipeline on the result, and opens a PR with the complete summary from the agents. The final merge to main requires human approval.

---

## 3. The Pipeline Core Contract

The Core only understands one language. It doesn't know who called it or where the results go. It only knows how to receive a `PipelineRequest` and emit `PipelineEvent`.

### 3.1 PipelineRequest (Input)

This is the only thing the Core needs to start. Any adapter must translate its request to this format.

```json
{
  "request_id": "uuid-v4",
  "branch": "feature/auth",
  "worktree_path": "/absolute/path/to/worktree",
  "base_branch": "main",
  "config": {
    "create_pipeline_branch": true,
    "auto_correct": true,
    "max_correction_attempts": 3,
    "tier_override": null,
    "agents": {
      "tests": { "enabled": true, "blocking": true },
      "security": { "enabled": true, "blocking": true },
      "architecture": { "enabled": true, "blocking": true },
      "performance": { "enabled": true, "blocking": false },
      "dependencies": { "enabled": true, "blocking": true },
      "code_quality": { "enabled": true, "blocking": false },
      "accessibility": { "enabled": true, "blocking": "conditional" },
      "documentation": { "enabled": true, "blocking": false }
    }
  },
  "metadata": {
    "triggered_by": "my-app",
    "task_id": "TASK-123",
    "callback_url": "https://my-app.com/api/webhooks/pipeline",
    "custom": {}
  }
}
```

**Key fields:**

| Field           | Required | Description                                                                                                                                                                                                                 |
| --------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `request_id`    | Yes      | Unique identifier for this execution. Generated by adapters.                                                                                                                                                                |
| `branch`        | Yes      | The branch on which the pipeline runs.                                                                                                                                                                                      |
| `worktree_path` | Yes      | Absolute path to the worktree where the code is.                                                                                                                                                                            |
| `base_branch`   | No       | Base branch for comparing changes. Default: `main`.                                                                                                                                                                         |
| `config`        | No       | Overrides the project's default configuration (`.pipeline/config.yaml`). If not sent, uses the project's config. Includes `tier_override` to force a tier ("small", "medium", "large") instead of automatic classification. |
| `metadata`      | No       | Opaque data for the Core. Passed as-is in output events. Clients and adapters use it for correlation (e.g., `task_id` to know which entity to update in the client).                                                        |

**Note about `metadata`:** The Core doesn't read, interpret, or validate `metadata`. It receives it and includes it in every event it emits. It's the responsibility of the outbound adapters to interpret it. This keeps the Core completely decoupled.

### 3.2 PipelineEvent (Output)

The Core emits events through the Event Bus. Each event has a type, a timestamp, the `request_id` for correlation, and specific data.

```json
{
  "event_type": "pipeline.agent.completed",
  "request_id": "uuid-v4",
  "timestamp": "2026-02-14T12:01:30Z",
  "data": { ... },
  "metadata": { "triggered_by": "my-app", "task_id": "TASK-123", "callback_url": "..." }
}
```

### Complete event catalog

**Note:** This is the conceptual catalog of the SAD. The actual implementation has a slightly different catalog — see Appendix §A.9 and §A.13 for the differences.

| Event                       | When emitted                                                           | Data                                                                                                 |
| --------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `pipeline.accepted`         | The Service accepted the request (before classifying tier)             | `{ branch, worktree_path }`                                                                          |
| `pipeline.tier_classified`  | Tier classified via git diff --stat                                    | `{ tier, stats }`                                                                                    |
| `pipeline.started`          | The Claude agent started (session init)                                | `{ session_id, model }`                                                                              |
| `pipeline.containers.ready` | Sandbox ready, and optionally project containers + browser             | `{ worktree_path, has_browser }`                                                                     |
| `pipeline.agent.started`    | A sub-agent (Task tool) was launched                                   | `{ tool_use_id, agent_name, input }`                                                                 |
| `pipeline.agent.completed`  | An individual agent finished                                           | `{ agent, status, details, duration_ms }`                                                            |
| `pipeline.correcting`       | A correction cycle was detected in the agent's text                    | `{ correction_number, text }`                                                                        |
| `pipeline.cli_message`      | Each raw CLIMessage from the agent (for UI rendering)                  | `{ cli_message }`                                                                                    |
| `pipeline.completed`        | Pipeline finished successfully (all blocking agents pass)              | `{ result, duration_ms, num_turns, cost_usd, corrections_count, branch, tier, corrections_applied }` |
| `pipeline.failed`           | Pipeline failed (agent error, attempts exhausted, or unexpected error) | `{ error, result, duration_ms, cost_usd, corrections_count }`                                        |
| `pipeline.stopped`          | Pipeline stopped manually (POST /:id/stop)                             | `{}`                                                                                                 |

### Example event sequence

```
→ pipeline.accepted          { branch: "feature/auth", worktree_path: "/path/to/worktree" }
→ pipeline.tier_classified   { tier: "large", stats: { files: 12, lines: 390 } }
→ pipeline.containers.ready  { worktree_path: "/path/to/worktree", has_browser: true }
→ pipeline.started           { session_id: "sess-xxx", model: "sonnet" }
→ pipeline.cli_message       { cli_message: { type: "system", subtype: "init", ... } }
→ pipeline.agent.started     { tool_use_id: "tu_1", agent_name: "Task", input: {...} }
→ pipeline.cli_message       { cli_message: { type: "assistant", ... } }  (many of these)
→ pipeline.agent.started     { tool_use_id: "tu_2", agent_name: "Task", input: {...} }
→ ...
→ pipeline.correcting        { correction_number: 1, text: "Re-running failing agents..." }
→ pipeline.agent.started     { tool_use_id: "tu_9", agent_name: "Task", input: {...} }
→ ...
→ pipeline.completed         { result: "...", duration_ms: 180000, num_turns: 45, cost_usd: 2.5, corrections_count: 1, branch: "feature/auth", tier: "large", corrections_applied: ["security: token expiration"] }
```

**Note:** The `pipeline.cli_message` events are the most frequent — one per CLIMessage from the agent (tool calls, bash output, assistant text, etc.). They are used for UI rendering via the ingest webhook. The lifecycle events (`started`, `completed`, `correcting`, etc.) are much less frequent.

---

## 4. The Event Bus

The Event Bus is the nervous system that connects the Core with the adapters. It's the only point of contact — the Core publishes events, the adapters listen to them.

### Responsibilities

1. **Receive events** from the Pipeline Core
2. **Distribute events** to all subscribed outbound adapters
3. **Persist events** optionally in `.pipeline/events/` for auditing and replay
4. **Guarantee delivery** — if an adapter fails, the event is not lost

### Implementation

The Event Bus can be as simple or complex as needed, depending on the deployment context:

| Context                         | Implementation                 | Description                                                                                 |
| ------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------- |
| **Local machine**               | EventEmitter (Node.js)         | In-memory pub/sub. Simple, fast, no dependencies.                                           |
| **Local machine + persistence** | EventEmitter + JSON files      | Each event is written to `.pipeline/events/{request_id}.jsonl`. Allows replay and auditing. |
| **Multiple machines**           | Redis Pub/Sub                  | Events are distributed between machines. Adapters can run on different servers.             |
| **Enterprise**                  | Message queue (RabbitMQ, NATS) | Delivery guarantees, dead letter queues, advanced routing.                                  |

### Event persistence

Each pipeline execution generates an event file in `.pipeline/events/`:

```
.pipeline/
├── events/                              # Or custom path via config.events.path
│   ├── abc-123.jsonl                    # Events from pipeline abc-123
│   ├── def-456.jsonl                    # Events from pipeline def-456
│   └── ...
├── manifest.json
└── config.yaml
```

**Note:** Events are stored by `request_id` (not by date/branch). The persistence path is configurable via `config.events.path` or via the `EVENTS_PATH` environment variable (default: `~/.funny/pipeline-events`).

Each `.jsonl` file contains one event per line, in chronological order:

```jsonl
{"event_type":"pipeline.accepted","request_id":"abc-123","timestamp":"2026-02-14T12:00:00Z","data":{"branch":"feature/auth","worktree_path":"/path/to/worktree"}}
{"event_type":"pipeline.tier_classified","request_id":"abc-123","timestamp":"2026-02-14T12:00:00.1Z","data":{"tier":"large","stats":{"files":12,"lines":390}}}
{"event_type":"pipeline.containers.ready","request_id":"abc-123","timestamp":"2026-02-14T12:00:02Z","data":{"worktree_path":"/path/to/worktree","has_browser":true}}
...
```

**Benefits of persistence:**

1. **Auditing** — You can reconstruct exactly what happened in each pipeline
2. **Replay** — If an outbound adapter failed, the event file can be re-processed
3. **Debugging** — When something goes wrong, the event history tells the complete story
4. **Metrics** — You can analyze duration, failure rate, slowest agents, etc.

---

## 4b. Logging System

The Event Bus handles communication between components. The logging system is different: it's a **complete record of everything that happens** — every action from every agent, every git command, every GitHub call, every Director decision. It's the system's black box.

### Difference between events and logs

|                       | Events (Event Bus)                | Logs                                                 |
| --------------------- | --------------------------------- | ---------------------------------------------------- |
| **Purpose**           | Communication between components  | Observability and debugging                          |
| **Granularity**       | High level (`pipeline.completed`) | Detailed (`agent security scanning auth.ts line 45`) |
| **Who consumes them** | Outbound adapters, Director       | Humans, dashboards, alerts                           |
| **Format**            | PipelineEvent (typed)             | Log entry (structured but flexible)                  |

### Log format

Each entry is structured JSON with fixed fields:

```json
{
  "timestamp": "2026-02-14T12:00:01.234Z",
  "level": "info",
  "source": "core.agent.security",
  "request_id": "abc-123",
  "action": "scan.file",
  "message": "Scanning auth.ts for vulnerabilities",
  "data": {
    "file": "src/auth.ts",
    "lines_scanned": 145,
    "vulnerabilities_found": 1
  },
  "duration_ms": 3200
}
```

**Fixed fields:**

| Field         | Description                                                                          |
| ------------- | ------------------------------------------------------------------------------------ |
| `timestamp`   | Exact moment (milliseconds)                                                          |
| `level`       | `debug` / `info` / `warn` / `error` / `fatal`                                        |
| `source`      | Component that generated the log (see table below)                                   |
| `request_id`  | Correlation — all entries from a pipeline share the same ID. `null` for system logs. |
| `action`      | Specific action that was executed                                                    |
| `message`     | Human-readable description                                                           |
| `data`        | Structured data specific to the action                                               |
| `duration_ms` | Duration of the action (if applicable)                                               |

### Sources (components that log)

| Source                      | What it logs                                                     | Examples                                                                                                              |
| --------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `inbound.rest`              | Incoming HTTP requests                                           | `POST /pipeline/run received`, `202 Accepted sent`                                                                    |
| `inbound.cli`               | CLI commands                                                     | `pipeline run --branch feature/auth`                                                                                  |
| `core.pipeline`             | Pipeline operations                                              | `Pipeline started`, `Tier classified: medium`, `Pipeline completed`                                                   |
| `core.agent.tests`          | Tests agent                                                      | `Running test suite`, `25/25 tests passed`, `Test auth.spec.ts failed`                                                |
| `core.agent.security`       | Security agent                                                   | `Scanning auth.ts`, `Vulnerability found: token without expiration`                                                   |
| `core.agent.architecture`   | Architecture agent                                               | `Evaluating coupling`, `SOLID violation in UserService`                                                               |
| `core.agent.performance`    | Performance agent                                                | `Detected O(n^2) in utils.ts:45`                                                                                      |
| `core.agent.dependencies`   | Dependencies agent                                               | `Auditing 45 dependencies`, `CVE-2026-1234 in lodash`                                                                 |
| `core.agent.code_quality`   | Code quality agent                                               | `Analyzing consistency`, `Duplication detected`                                                                       |
| `core.agent.accessibility`  | Accessibility agent                                              | `Skipped: no UI changes`, `WCAG AA violation`                                                                         |
| `core.agent.documentation`  | Documentation agent                                              | `README outdated`, `Missing docstring`                                                                                |
| `core.correction`           | Auto-correction                                                  | `Attempt 1/3 for security`, `Fix applied`, `Commit created`                                                           |
| `core.containers`           | Infrastructure: mandatory sandbox + project containers + browser | `Sandbox container started`, `compose.yml detected`, `Containers started`, `Health check passed`, `CDP browser ready` |
| `director`                  | Director decisions                                               | `Manifest read: 2 ready`, `Branch eligible`, `Dispatching to Integrator`                                              |
| `integrator`                | Integrator operations                                            | `Creating integration/ branch`, `PR #42 created`, `Rebase of stale PR`                                                |
| `git`                       | Every git command executed                                       | `git checkout -b pipeline/feature/auth`, `git merge --no-ff`, `git push`                                              |
| `github`                    | Every GitHub API call                                            | `gh pr create → #42`, `gh pr comment`, `Webhook received: PR merged`                                                  |
| `adapter.outbound.webhook`  | Webhooks sent                                                    | `POST to client → 200 OK`, `POST to client → timeout → DLQ`                                                           |
| `adapter.outbound.slack`    | Slack notifications                                              | `Message sent to #dev`                                                                                                |
| `adapter.outbound.manifest` | Manifest writes                                                  | `Branch added to ready[]`, `Moved to pending_merge[]`                                                                 |
| `event-bus`                 | Event publishing                                                 | `Event pipeline.completed published`, `3 subscribers notified`                                                        |
| `saga`                      | Transactions                                                     | `Step create_branch completed`, `Compensation executed`                                                               |
| `circuit-breaker`           | Circuit states                                                   | `GitHub API circuit OPEN`, `Circuit reset to CLOSED`                                                                  |
| `dlq`                       | Dead letter queue                                                | `Event queued for retry`, `Retry 3/5 successful`                                                                      |

### Log levels

| Level   | When used                              | Example                                                               |
| ------- | -------------------------------------- | --------------------------------------------------------------------- |
| `debug` | Granular details, only for development | `Scanning line 45 of auth.ts`                                         |
| `info`  | Normal operations, expected flow       | `Pipeline started for feature/auth`                                   |
| `warn`  | Something unexpected but not fatal     | `Performance warning: O(n^2)`, `Retry 2/5 for webhook`                |
| `error` | Failure that requires attention        | `Agent security failed`, `PR creation failed`, `Circuit breaker OPEN` |
| `fatal` | The system cannot continue             | `Claude Code unavailable`, `Filesystem read-only`                     |

### Storage

```
.pipeline/
├── logs/
│   ├── abc-123.jsonl              # Everything that happened in pipeline abc-123
│   ├── def-456.jsonl              # Everything that happened in pipeline def-456
│   └── system.jsonl               # System logs (Director, Integrator, DLQ, infrastructure)
```

**Implementation note:** Log files are stored in a flat directory (no subdirectories by date). Each `request_id` has its own JSONL file.

**Two types of files:**

| File                 | Contents                                                         | When created                          |
| -------------------- | ---------------------------------------------------------------- | ------------------------------------- |
| `{request_id}.jsonl` | Everything that happened in a specific pipeline                  | When the Core receives a request      |
| `system.jsonl`       | Director, Integrator, Circuit Breakers, DLQ, infrastructure logs | Always (while the Service is running) |

Each request_id has its own file. This allows viewing the complete history of a pipeline in a single place, without filtering.

### Example: complete log of a pipeline

```jsonl
{"timestamp":"2026-02-14T12:00:00.000Z","level":"info","source":"inbound.rest","request_id":"abc-123","action":"request.received","message":"POST /pipeline/run","data":{"branch":"feature/auth","tier_override":null}}
{"timestamp":"2026-02-14T12:00:00.005Z","level":"info","source":"core.pipeline","request_id":"abc-123","action":"pipeline.start","message":"Pipeline started","data":{"branch":"feature/auth"}}
{"timestamp":"2026-02-14T12:00:00.010Z","level":"info","source":"git","request_id":"abc-123","action":"git.command","message":"git diff --stat main...feature/auth","data":{"files_changed":12,"lines_added":340,"lines_removed":50},"duration_ms":45}
{"timestamp":"2026-02-14T12:00:00.060Z","level":"info","source":"core.pipeline","request_id":"abc-123","action":"tier.classified","message":"Change classified as Large","data":{"tier":"large","reason":"12 files, 390 lines"}}
{"timestamp":"2026-02-14T12:00:00.070Z","level":"info","source":"core.containers","request_id":"abc-123","action":"containers.detect","message":"compose.yml detected in worktree","data":{"compose_file":"compose.yml"}}
{"timestamp":"2026-02-14T12:00:02.000Z","level":"info","source":"core.containers","request_id":"abc-123","action":"containers.start","message":"Containers started via podman compose","data":{"exposed_ports":{"web":3000}},"duration_ms":1930}
{"timestamp":"2026-02-14T12:00:04.500Z","level":"info","source":"core.containers","request_id":"abc-123","action":"containers.healthy","message":"Health check passed","data":{"app_url":"http://localhost:3000"},"duration_ms":2500}
{"timestamp":"2026-02-14T12:00:05.000Z","level":"info","source":"core.containers","request_id":"abc-123","action":"browser.ready","message":"CDP browser ready (Playwright)","data":{"mcp_tools":["cdp_navigate","cdp_screenshot","cdp_get_dom"]},"duration_ms":500}
{"timestamp":"2026-02-14T12:00:05.010Z","level":"info","source":"event-bus","request_id":"abc-123","action":"event.publish","message":"pipeline.containers.ready published","data":{"subscribers":3}}
{"timestamp":"2026-02-14T12:00:05.080Z","level":"info","source":"git","request_id":"abc-123","action":"git.command","message":"git checkout -b pipeline/feature/auth feature/auth","data":{"new_branch":"pipeline/feature/auth"},"duration_ms":120}
{"timestamp":"2026-02-14T12:00:05.200Z","level":"info","source":"core.pipeline","request_id":"abc-123","action":"agents.spawn","message":"Launching 8 agents (tier: large) with browser tools","data":{"agents":["tests","security","architecture","dependencies","code_quality","performance","accessibility","documentation"],"browser_tools":true}}
{"timestamp":"2026-02-14T12:00:00.210Z","level":"info","source":"core.agent.tests","request_id":"abc-123","action":"agent.start","message":"Tests agent started"}
{"timestamp":"2026-02-14T12:00:00.210Z","level":"info","source":"core.agent.security","request_id":"abc-123","action":"agent.start","message":"Security agent started"}
{"timestamp":"2026-02-14T12:00:05.100Z","level":"debug","source":"core.agent.security","request_id":"abc-123","action":"scan.file","message":"Scanning src/auth.ts","data":{"file":"src/auth.ts","lines":145}}
{"timestamp":"2026-02-14T12:00:08.300Z","level":"warn","source":"core.agent.security","request_id":"abc-123","action":"vulnerability.found","message":"JWT token without expiration","data":{"file":"src/auth.ts","line":42,"severity":"HIGH","type":"missing-token-expiration"}}
{"timestamp":"2026-02-14T12:00:15.000Z","level":"info","source":"core.agent.tests","request_id":"abc-123","action":"agent.complete","message":"Tests completed: 25/25 passed","data":{"total":25,"passed":25,"failed":0,"coverage":"87%"},"duration_ms":14790}
{"timestamp":"2026-02-14T12:00:22.000Z","level":"error","source":"core.agent.security","request_id":"abc-123","action":"agent.complete","message":"Security failed: 1 HIGH vulnerability","data":{"status":"fail","vulnerabilities":[{"type":"missing-token-expiration","severity":"HIGH","file":"src/auth.ts","line":42}]},"duration_ms":21790}
{"timestamp":"2026-02-14T12:00:22.050Z","level":"info","source":"core.correction","request_id":"abc-123","action":"correction.start","message":"Auto-correction attempt 1/3 for security","data":{"attempt":1,"agent":"security","issue":"missing-token-expiration"}}
{"timestamp":"2026-02-14T12:00:25.000Z","level":"info","source":"git","request_id":"abc-123","action":"git.command","message":"git diff (correction applied)","data":{"files_changed":1,"diff":"+  expiresIn: '1h'"}}
{"timestamp":"2026-02-14T12:00:25.100Z","level":"info","source":"git","request_id":"abc-123","action":"git.command","message":"git commit -m 'fix(pipeline/security): add JWT token expiration'","data":{"sha":"fa3b2c1"},"duration_ms":80}
{"timestamp":"2026-02-14T12:00:25.200Z","level":"info","source":"core.correction","request_id":"abc-123","action":"correction.complete","message":"Correction successful","data":{"attempt":1,"success":true}}
{"timestamp":"2026-02-14T12:00:30.000Z","level":"info","source":"core.agent.security","request_id":"abc-123","action":"agent.rerun","message":"Re-running security post-correction","data":{"attempt":2}}
{"timestamp":"2026-02-14T12:00:35.000Z","level":"info","source":"core.agent.security","request_id":"abc-123","action":"agent.complete","message":"Security passed post-correction","data":{"status":"pass"},"duration_ms":5000}
{"timestamp":"2026-02-14T12:00:35.050Z","level":"info","source":"core.pipeline","request_id":"abc-123","action":"pipeline.approved","message":"Pipeline approved","data":{"approved":true,"corrections":["security: token expiration"],"main_sha_at_start":"abc123def"}}
{"timestamp":"2026-02-14T12:00:35.060Z","level":"info","source":"event-bus","request_id":"abc-123","action":"event.publish","message":"pipeline.completed published","data":{"subscribers":4}}
{"timestamp":"2026-02-14T12:00:35.070Z","level":"info","source":"adapter.outbound.manifest","request_id":"abc-123","action":"manifest.write","message":"Branch added to ready[]","data":{"branch":"feature/auth"}}
{"timestamp":"2026-02-14T12:00:35.080Z","level":"info","source":"adapter.outbound.webhook","request_id":"abc-123","action":"webhook.send","message":"POST https://my-app.com/api/pipeline/events","data":{"event_type":"pipeline.completed","status_code":200},"duration_ms":150}
{"timestamp":"2026-02-14T12:00:35.100Z","level":"info","source":"git","request_id":"abc-123","action":"git.command","message":"git checkout feature/auth && git merge pipeline/feature/auth","data":{"merge_back":true},"duration_ms":200}
{"timestamp":"2026-02-14T12:00:35.300Z","level":"info","source":"saga","request_id":"abc-123","action":"saga.complete","message":"Saga completed: all steps successful","data":{"steps_completed":["create_branch","run_agents","auto_correct","merge_back"]}}
```

### Example: Director log (system.jsonl)

```jsonl
{"timestamp":"2026-02-14T12:00:35.100Z","level":"info","source":"director","request_id":null,"action":"director.activate","message":"Director activated by pipeline.completed","data":{"trigger":"event","manifest_ready":1}}
{"timestamp":"2026-02-14T12:00:35.110Z","level":"info","source":"director","request_id":null,"action":"manifest.read","message":"Manifest: 1 in ready, 0 in pending_merge","data":{"ready":["feature/auth"],"pending_merge":[]}}
{"timestamp":"2026-02-14T12:00:35.120Z","level":"info","source":"director","request_id":null,"action":"branch.eligible","message":"feature/auth eligible for integration","data":{"branch":"feature/auth","priority":1,"depends_on":[],"deps_satisfied":true}}
{"timestamp":"2026-02-14T12:00:35.130Z","level":"info","source":"integrator","request_id":null,"action":"integration.start","message":"Preparing PR for feature/auth","data":{"branch":"feature/auth","target":"main"}}
{"timestamp":"2026-02-14T12:00:35.150Z","level":"info","source":"git","request_id":null,"action":"git.command","message":"git checkout -b integration/feature/auth main","duration_ms":100}
{"timestamp":"2026-02-14T12:00:35.260Z","level":"info","source":"git","request_id":null,"action":"git.command","message":"git merge --no-ff pipeline/feature/auth","data":{"conflicts":false},"duration_ms":150}
{"timestamp":"2026-02-14T12:00:40.000Z","level":"info","source":"github","request_id":null,"action":"gh.pr.create","message":"PR created","data":{"pr_number":42,"pr_url":"https://github.com/org/repo/pull/42","title":"Integrate: feature/auth","base":"main","head":"integration/feature/auth"},"duration_ms":4600}
{"timestamp":"2026-02-14T12:00:40.010Z","level":"info","source":"adapter.outbound.manifest","request_id":null,"action":"manifest.move","message":"feature/auth moved from ready to pending_merge","data":{"branch":"feature/auth","pr_number":42}}
{"timestamp":"2026-02-14T12:05:00.000Z","level":"info","source":"github","request_id":null,"action":"gh.webhook.received","message":"PR #42 merged by human","data":{"pr_number":42,"merged_by":"developer","commit_sha":"xyz789"}}
{"timestamp":"2026-02-14T12:05:00.050Z","level":"info","source":"adapter.outbound.manifest","request_id":null,"action":"manifest.move","message":"feature/auth moved from pending_merge to merge_history","data":{"branch":"feature/auth","commit_sha":"xyz789"}}
{"timestamp":"2026-02-14T12:05:00.100Z","level":"info","source":"git","request_id":null,"action":"git.command","message":"git branch -d pipeline/feature/auth","data":{"deleted":true},"duration_ms":50}
{"timestamp":"2026-02-14T12:05:00.160Z","level":"info","source":"git","request_id":null,"action":"git.command","message":"git push origin --delete pipeline/feature/auth","duration_ms":800}
{"timestamp":"2026-02-14T12:05:00.170Z","level":"info","source":"git","request_id":null,"action":"git.command","message":"git branch -d integration/feature/auth","data":{"deleted":true},"duration_ms":50}
{"timestamp":"2026-02-14T12:05:01.000Z","level":"info","source":"git","request_id":null,"action":"git.command","message":"git push origin --delete integration/feature/auth","duration_ms":780}
{"timestamp":"2026-02-14T12:05:01.050Z","level":"info","source":"director","request_id":null,"action":"cleanup.complete","message":"Branches cleaned for feature/auth","data":{"deleted":["pipeline/feature/auth","integration/feature/auth"]}}
```

### Log queries

The JSONL format + fixed fields allows querying with standard tools:

```bash
# Everything that happened in a specific pipeline
cat .pipeline/logs/abc-123.jsonl

# Only errors
cat .pipeline/logs/*.jsonl | jq 'select(.level == "error")'

# All git commands from a pipeline
cat .pipeline/logs/abc-123.jsonl | jq 'select(.source == "git")'

# Director actions
cat .pipeline/logs/system.jsonl | jq 'select(.source == "director")'

# What a specific component did
cat .pipeline/logs/abc-123.jsonl | jq 'select(.source == "pipeline.agent")'

# Failed webhooks
cat .pipeline/logs/system.jsonl | jq 'select(.source == "webhook" and .level == "error")'
```

### Configuration

```yaml
logging:
  level: 'info' # Minimum level: debug | info | warn | error
  path: '.pipeline/logs/'
  format: 'jsonl'
  retention_days: 30 # Delete logs older than 30 days
  per_request: true # Create file per request_id
  system_log: true # System log (Director, infra)
  console:
    enabled: true # Show logs in Service stdout
    level: 'info' # Level for console (can be different)
    color: true # Colorize by level
  sources: # Enable/disable specific sources
    git: true # Log every git command
    github: true # Log every GitHub API call
    agents: true # Log agent actions
    event_bus: true # Log event publishing
    adapters: true # Log outbound adapters
```

### REST API for logs

The Pipeline Service exposes endpoints to query logs without accessing the filesystem:

```
GET /logs/pipeline/{request_id}
GET /logs/pipeline/{request_id}?source=pipeline.agent
GET /logs/pipeline/{request_id}?level=error

GET /logs/system
GET /logs/system?source=director
GET /logs/system?level=warn

GET /logs/requests                     # List all request_ids with logs
```

All endpoints support query params: `source`, `level`, `from` (timestamp), `to` (timestamp), `limit`, `offset`.

---

## 5. The REST API of the Pipeline Service

The Pipeline Service exposes a REST API. It's the only way external systems communicate with the pipeline. There's no SDK, no process spawning, no libraries. **Only HTTP.**

### 5.1 Endpoints

#### POST /pipeline/run — Run pipeline on a branch

```
POST /pipeline/run
Content-Type: application/json
Authorization: Bearer {token}

{
  "branch": "feature/auth",
  "worktree_path": "/path/to/worktree",
  "priority": 1,
  "depends_on": [],
  "metadata": {
    "task_id": "TASK-123",
    "triggered_by": "my-app"
  }
}
```

**Immediate response (202 Accepted):**

```json
{
  "request_id": "abc-123-uuid",
  "status": "accepted",
  "pipeline_branch": "pipeline/feature/auth",
  "events_url": "/pipeline/abc-123-uuid/events"
}
```

The Service responds `202 Accepted` immediately. **It doesn't block.** The client doesn't wait for it to finish. Results arrive via:

- Outbound webhooks (the Service calls the client)
- SSE stream (the client listens)
- Polling the status endpoint

#### GET /pipeline/:request_id — Status of a pipeline

```
GET /pipeline/abc-123-uuid

{
  "request_id": "abc-123-uuid",
  "branch": "feature/auth",
  "status": "running",          // accepted | running | correcting | approved | failed | error
  "started_at": "2026-02-14T12:00:00Z",
  "agents": {
    "tests":         { "status": "pass",    "details": "25/25" },
    "security":      { "status": "running", "details": null },
    "architecture":  { "status": "pass",    "details": "OK" },
    "performance":   { "status": "pending", "details": null },
    "dependencies":  { "status": "pass",    "details": "All OK" },
    "code_quality":  { "status": "pending", "details": null },
    "accessibility": { "status": "skipped", "details": "No UI changes" },
    "documentation": { "status": "pending", "details": null }
  },
  "corrections": [],
  "metadata": { "task_id": "TASK-123" }
}
```

#### GET /pipeline/:request_id/events — Event stream (SSE)

```
GET /pipeline/abc-123-uuid/events
Accept: text/event-stream

data: {"event_type":"pipeline.started","timestamp":"2026-02-14T12:00:00Z","data":{"branch":"feature/auth"}}

data: {"event_type":"pipeline.agent.completed","timestamp":"2026-02-14T12:00:15Z","data":{"agent":"tests","status":"pass"}}

data: {"event_type":"pipeline.agent.completed","timestamp":"2026-02-14T12:00:22Z","data":{"agent":"security","status":"fail"}}

data: {"event_type":"pipeline.correction.started","timestamp":"2026-02-14T12:00:23Z","data":{"attempt":1,"agent":"security"}}

data: {"event_type":"pipeline.completed","timestamp":"2026-02-14T12:00:45Z","data":{"approved":true}}
```

This endpoint allows any client to receive events in real time via Server-Sent Events. The client opens the connection and receives events as they occur.

#### POST /director/run — Activate the Director manually

```
POST /director/run
Authorization: Bearer {token}

{}
```

Response:

```json
{
  "cycle_id": "dir-789",
  "status": "started",
  "manifest_entries": 2
}
```

#### GET /director/status — Director status

```
GET /director/status

{
  "last_cycle": "2026-02-14T12:10:00Z",
  "manifest": {
    "ready": 2,
    "pending_merge": 1,
    "merge_history": 1
  },
  "merge_queue": [
    { "branch": "feature/auth", "priority": 1, "eligible": true },
    { "branch": "feature/ui", "priority": 3, "eligible": false, "blocked_by": "feature/api" }
  ]
}
```

#### GET /logs/pipeline/:request_id — Logs of a pipeline

```
GET /logs/pipeline/abc-123?source=pipeline.agent&level=warn

[
  {
    "timestamp": "2026-02-14T12:00:08.300Z",
    "level": "warn",
    "source": "core.agent.security",
    "action": "vulnerability.found",
    "message": "JWT token without expiration",
    "data": { "file": "src/auth.ts", "line": 42, "severity": "HIGH" }
  }
]
```

Query params: `source`, `level`, `action`, `from` (timestamp), `to` (timestamp), `limit`.

#### GET /logs/system — System logs

```
GET /logs/system?source=director

[
  {
    "timestamp": "2026-02-14T12:00:35.100Z",
    "level": "info",
    "source": "director",
    "action": "director.activate",
    "message": "Director activated by pipeline.completed"
  }
]
```

### 5.2 Outbound: How the Service notifies clients

The Pipeline Service **actively notifies** external systems when something happens. Clients don't need to poll.

#### Webhooks (Push)

The Service makes HTTP POST to configured URLs when events occur:

```
Pipeline Service ─── POST ──► https://my-app.com/api/pipeline/events
                               {
                                 "event_type": "pipeline.completed",
                                 "request_id": "abc-123",
                                 "data": { "branch": "feature/auth", "approved": true, "results": {...} },
                                 "metadata": { "task_id": "TASK-123" }
                               }
```

Webhooks are configured in `.pipeline/config.yaml`:

```yaml
adapters:
  outbound:
    client_notifier:
      enabled: true
      url: '${CLIENT_WEBHOOK_URL}' # URL of the client that wants to receive events
      auth: 'bearer-token'
      token: '${CLIENT_API_TOKEN}'
      events: # Only the events the client cares about
        - 'pipeline.started'
        - 'pipeline.agent.completed'
        - 'pipeline.completed'
        - 'pipeline.failed'
        - 'integration.pr.created'
        - 'integration.pr.merged'
        - 'integration.completed'
```

#### SSE (Server-Sent Events)

Any client can open an SSE connection to the `/pipeline/:id/events` endpoint and receive events in real time. Useful for UIs that want to show progress.

#### Internal (within the Service)

These outbound adapters live inside the Service and don't require external configuration:

| Internal adapter     | What it does                                                            |
| -------------------- | ----------------------------------------------------------------------- |
| **Manifest Writer**  | Listens to `pipeline.completed` and writes to `.pipeline/manifest.json` |
| **Director Trigger** | Listens to `pipeline.completed` and activates the Director              |
| **Event Persister**  | Writes each event to `.pipeline/events/*.jsonl` for auditing            |

### 5.3 Detailed internal adapters

#### Manifest Writer

```
Event Bus                           Manifest Writer                     manifest.json
    │                                     │                                  │
    │  pipeline.completed                 │                                  │
    │  { approved: true,                  │                                  │
    │    branch: "feature/auth",          │                                  │
    │    results: {...} }                 │                                  │
    │ ───────────────────────────────────►│                                  │
    │                                     │  Append to ready[]:              │
    │                                     │  {                               │
    │                                     │    branch: "feature/auth",       │
    │                                     │    pipeline_result: {...},       │
    │                                     │    ready_at: "2026-..."          │
    │                                     │  }                               │
    │                                     │ ────────────────────────────────►│
    │                                     │                                  │
```

**Key rule:** Only writes if `approved: true`. If the pipeline fails, the manifest is not touched.

#### GitHub Notifier

```
on pipeline.completed:
  if metadata.pr_number:
    gh pr comment {pr_number} --body "Pipeline passed ✅\n{formatted_results}"

on pipeline.failed:
  if metadata.pr_number:
    gh pr comment {pr_number} --body "Pipeline failed ❌\n{formatted_failures}"
```

#### Slack Notifier

```
on pipeline.completed:
  slack.post("#dev", "✅ {branch} approved — {summary}")

on pipeline.failed:
  slack.post("#dev", "❌ {branch} failed — {failures}")
  slack.post("#dev", "@{author} needs manual intervention")
```

### 5.4 Adding a new outbound adapter

To connect a new system to the Pipeline Service, you only need:

1. Create a module inside the Service that listens to events from the Event Bus
2. Translate the events to the external system's action
3. Add the configuration in `.pipeline/config.yaml`

**Example: adding a Discord adapter**

```
// Inside the Pipeline Service: adapters/discord-notifier.ts
eventBus.on("pipeline.completed", (event) => {
  discord.send(CHANNEL_ID, {
    embeds: [{
      title: `✅ Pipeline approved: ${event.data.branch}`,
      fields: Object.entries(event.data.results).map(([agent, result]) => ({
        name: agent,
        value: result.status,
        inline: true
      }))
    }]
  })
})
```

**Zero changes to the Core. Zero changes to other adapters. Zero changes to clients.** Just add a module to the Service.

---

## 6. Integration with External Clients

Any web service is a **pure client** of the Pipeline Service. It doesn't spawn processes, doesn't manage agents, doesn't know how the pipeline works. It just makes HTTP requests and receives HTTP callbacks.

### What a client needs to do

Just two things:

#### 1. Send worktrees to process (HTTP POST)

When the client decides that a worktree should go through the pipeline:

```
POST https://pipeline-service:3100/pipeline/run
Content-Type: application/json
Authorization: Bearer {token}

{
  "branch": "feature/auth",
  "worktree_path": "/path/to/worktree-auth",
  "priority": 1,
  "depends_on": [],
  "metadata": {
    "task_id": "TASK-123",
    "callback_url": "https://my-app.com/api/pipeline/events"
  }
}
```

The client already knows the branch and worktree path. It just sends them.

Immediate response:

```json
{ "request_id": "abc-123", "status": "accepted" }
```

The client saves the `request_id` associated with its task and goes on with its life.

#### 2. Receive notifications (HTTP endpoint)

Expose an endpoint where the Pipeline Service sends updates:

```
POST /api/pipeline/events    ← The client exposes this
Content-Type: application/json

{
  "event_type": "pipeline.completed",
  "request_id": "abc-123",
  "data": {
    "branch": "feature/auth",
    "approved": true,
    "results": {
      "tests": { "status": "pass", "details": "25/25" },
      "security": { "status": "pass", "details": "Auto-corrected" },
      ...
    },
    "corrections_applied": ["security: token expiration"]
  },
  "metadata": {
    "task_id": "TASK-123"
  }
}
```

The client reads `metadata.task_id`, looks up the corresponding entity, and updates its state. That's it.

### Map of events → suggested actions for the client

| Event received                          | Suggested action                               |
| --------------------------------------- | ---------------------------------------------- |
| `pipeline.started`                      | Mark task as "Pipeline Running"                |
| `pipeline.agent.completed`              | Update progress (e.g., "5/8 agents completed") |
| `pipeline.correction.started`           | Show indicator "Auto-correcting..."            |
| `pipeline.completed` { approved: true } | Mark task as "Approved"                        |
| `pipeline.failed`                       | Mark task as "Needs Attention" with details    |
| `integration.pr.created`                | Mark task as "PR Created" with link to PR      |
| `integration.pr.merged`                 | Mark task as "Merged"                          |
| `integration.completed`                 | Mark task as "Done"                            |
| `integration.failed`                    | Mark task as "Integration Failed" with details |

The client decides how to map these events to its own logic. It could be board columns, database states, user notifications, etc.

### Alternative option: SSE instead of webhooks

If the client prefers to **listen** instead of **receive**, it can open an SSE connection:

```javascript
// In the client (frontend or backend)
const eventSource = new EventSource(`https://pipeline-service:3100/pipeline/${requestId}/events`);

eventSource.onmessage = (event) => {
  const pipelineEvent = JSON.parse(event.data);

  switch (pipelineEvent.event_type) {
    case 'pipeline.started':
      updateTask(taskId, { status: 'pipeline_running' });
      break;
    case 'pipeline.agent.completed':
      updateTaskProgress(taskId, pipelineEvent.data);
      break;
    case 'pipeline.completed':
      updateTask(taskId, { status: 'approved', results: pipelineEvent.data.results });
      eventSource.close();
      break;
    case 'pipeline.failed':
      updateTask(taskId, { status: 'needs_attention', failures: pipelineEvent.data.failures });
      eventSource.close();
      break;
  }
};
```

### Complete diagram: Client <-> Pipeline Service

```
Client (any web service)                            Pipeline Service
     │                                                       │
     │  1. Decides to process a worktree                     │
     │                                                       │
     │  POST /pipeline/run                                   │
     │  { branch, worktree_path, metadata: { task_id } }    │
     │ ─────────────────────────────────────────────────────►│
     │                                                       │
     │  202 Accepted { request_id }                          │
     │ ◄─────────────────────────────────────────────────────│
     │                                                       │
     │  (client saves request_id)                            │  (internally: creates pipeline/ branch,
     │  (client goes on with its life)                       │   runs 8 agents, auto-corrects...)
     │                                                       │
     │               ... minutes pass ...                    │
     │                                                       │
     │  POST /api/pipeline/events (webhook to client)        │
     │  { event_type: "pipeline.started", task_id }          │
     │ ◄─────────────────────────────────────────────────────│
     │                                                       │
     │  (client updates state: "Pipeline Running")           │
     │                                                       │
     │  POST /api/pipeline/events                            │
     │  { event_type: "pipeline.agent.completed",            │
     │    data: { agent: "tests", status: "pass" } }         │
     │ ◄─────────────────────────────────────────────────────│
     │                                                       │
     │  (client updates progress: "1/8 agents")              │
     │                                                       │
     │  ... more agent events ...                            │
     │                                                       │
     │  POST /api/pipeline/events                            │
     │  { event_type: "pipeline.completed",                  │
     │    data: { approved: true, results: {...} } }         │
     │ ◄─────────────────────────────────────────────────────│
     │                                                       │
     │  (client marks as "Approved")                         │
     │                                                       │
     │  ... Director detects, dispatches to Integrator ...   │
     │                                                       │
     │  POST /api/pipeline/events                            │
     │  { event_type: "integration.pr.created",              │
     │    data: { branch: "feature/auth",                    │
     │            pr_number: 42, pr_url: "..." } }           │
     │ ◄─────────────────────────────────────────────────────│
     │                                                       │
     │  (client marks as "PR Created" with link)             │
     │                                                       │
     │  ... human reviews and approves PR #42 on GitHub ...  │
     │                                                       │
     │  POST /api/pipeline/events                            │
     │  { event_type: "integration.pr.merged",               │
     │    data: { branch: "feature/auth",                    │
     │            pr_number: 42, commit_sha: "abc123" } }    │
     │ ◄─────────────────────────────────────────────────────│
     │                                                       │
     │  (client marks as "Done" ✅)                           │
     │                                                       │
```

### Summary: What a client needs to implement

```
1. triggerPipeline(task)              → HTTP POST to Pipeline Service (5 lines)
2. handlePipelineEvent(event)         → Receive webhook and update state (switch with 6 cases)
3. mapEventToStatus(eventType)        → Translate event_type to internal state (mapping table)
```

Three functions. The client doesn't know that agents exist, that there's an Event Bus, that there's a Director, that there's auto-correction. It only knows: "I send a POST with a worktree, I receive webhooks with results."

---

## 6. The Pipeline Branch

When the Core receives a `PipelineRequest`, the first thing it does is create a dedicated branch for the review process. This protects the developer's original branch.

### Why a separate branch

1. **Protection** — The developer's branch remains intact as a reference
2. **Isolation** — Auto-corrections don't contaminate the original work
3. **Rollback** — If something goes wrong, the `pipeline/` branch is discarded and the original remains unchanged
4. **Traceability** — You can diff between the original and the pipeline branch to see exactly what the system corrected

### Branch flow

```
feature/auth                      pipeline/feature/auth
    │                                     │
    │  (developer finishes)               │
    │                                     │
    ├──── checkout ──────────────────────►│  Exact copy
    │                                     │
    │                                     │  [8 agents run]
    │                                     │
    │                                     │  ❌ security fails
    │                                     │
    │                                     │  [auto-correction]
    │                                     │  commit: "fix: token expiration"
    │                                     │
    │                                     │  [re-verification]
    │                                     │  ✅ everything passes
    │                                     │
    │                                     │  pipeline.completed { approved: true }
    │                                     │
    │  ◄──── merge back ─────────────────│  The fixes return to the original branch
    │                                     │
    │  (branch ready for integration)     │  (can be deleted)
    │                                     │
```

### Naming convention

| Original branch | Pipeline branch          |
| --------------- | ------------------------ |
| `feature/auth`  | `pipeline/feature/auth`  |
| `fix/login-bug` | `pipeline/fix/login-bug` |
| `refactor/api`  | `pipeline/refactor/api`  |

### What happens if main changes while the pipeline is running

The Core records the SHA of main when creating the `pipeline/{branch}` branch. If main advances during pipeline execution:

```
pipeline/feature/auth was created when main was at abc123
         │
         │  ... pipeline running (minutes) ...
         │
         │  Meanwhile: PR #41 merges to main → main is now at def456
         │
         ▼
Pipeline finishes: approved: true
         │
         ▼
Does main_sha_at_start == current main HEAD?
         │
    ┌────┴────┐
    │         │
  Yes (=)   No (≠)
    │         │
    │    The pipeline validated against
    │    a main that no longer exists.
    │         │
    │    Do the files modified in main
    │    overlap with those in this branch?
    │         │
    │    ┌────┴────┐
    │    │         │
    │  No        With
    │  overlap   overlap
    │    │         │
    │    │    Re-run pipeline
    │    │    against current main
    │    │         │
    ▼    ▼         ▼
  Approved      Emit pipeline.rebase_needed
  (normal flow)
```

The Core saves `main_sha_at_start` in the `pipeline.completed` event. The Integrator uses this to know if it needs to rebase when creating the `integration/` branch.

**Rule:** The pipeline **is not automatically invalidated** when main changes. Validation against current main happens in the integration step (when the Integrator creates the `integration/` branch and re-runs the pipeline post-merge). This avoids unnecessary re-executions.

### Configuration

```yaml
pipeline:
  branch:
    prefix: 'pipeline/' # Prefix for pipeline branches
    merge_back: true # Merge corrections back to the original branch
    delete_after_merge: true # Delete pipeline/ branch after successful merge
    keep_on_failure: true # Keep pipeline/ branch on failure (for debugging)
```

---

## 7. The Pipeline: 8 Quality Agents

The pipeline has 8 agents, but **not all 8 always run**. The Core analyzes the size and type of the modification to decide how many agents to execute.

### 7.0 Execution tiers

The Core runs `git diff --stat` against `base_branch` to classify the change. Before launching the agents, the system executes a **Step 0: Container Infrastructure** with two layers: (1) **always** creates a Podman sandbox container where the agent runs (mandatory), and (2) optionally, if the project has a `compose.yml`, starts project containers, waits for health checks, and creates an MCP server with browser tools (Playwright CDP). If project containers are available, **all agents** receive access to browser tools (`cdp_navigate`, `cdp_screenshot`, `cdp_get_dom`).

```
PipelineRequest received
         │
         ▼
Classify tier: git diff --stat base_branch...HEAD
         │
         ▼
   ┌─────┴──────────────────────────────┐
   │  Classify:                          │
   │                                     │
   │  files_modified = N                 │
   │  lines_changed = M                 │
   └─────┬──────────────────────────────┘
         │
         ▼
   ┌─────────────────────────────────────┐
   │  Step 0: Container Infrastructure   │
   │                                     │
   │  MANDATORY:                         │
   │  1. Verify Podman installed         │
   │  2. podman build (sandbox image)    │
   │  3. podman run -d (sandbox)         │
   │     → mount worktree read-only      │
   │     → copy files to /workspace      │
   │     → git init + fetch + checkout   │
   │  4. createSpawnFn(requestId)        │
   │     → agent runs via podman exec    │
   │                                     │
   │  OPTIONAL (if compose.yml exists):  │
   │  5. podman compose up -d            │
   │  6. waitForHealthy() → HTTP poll    │
   │  7. createCdpMcpServer(appUrl)      │
   │     → Playwright headless Chrome    │
   │     → MCP tools: cdp_navigate,      │
   │       cdp_screenshot, cdp_get_dom   │
   │                                     │
   │  If NO compose:                     │
   │  → Sandbox ready, no browser tools  │
   │    (mcpServers = undefined)         │
   └─────┬──────────────────────────────┘
         │
    ┌────┴────────────┬──────────────────┐
    │                 │                  │
    ▼                 ▼                  ▼
 SMALL              MEDIUM             LARGE
 2 agents           5 agents           8 agents
    │                 │                  │
    ▼                 ▼                  ▼
┌──────┐┌──────┐  ┌──────┐┌──────┐  ┌──────┐┌──────┐┌──────┐
│Tests ││Secur.│  │Archi.││Deps. │  │Perf. ││Acces.││Docs. │
└──────┘└──────┘  │Code Q│       │  └──────┘└──────┘└──────┘
                  └──────┘└──────┘
                  (+ the 2 from Small)  (+ the 5 from Medium)

All agents run inside the sandbox container (via podman exec).
If there are project containers, they receive mcpServers with cdp_* tools.
```

#### Classification criteria

| Tier       | Criteria                                                             | Agents                                          | Example                                           |
| ---------- | -------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------- |
| **Small**  | <= 3 files modified, <= 50 lines, 0 new files, no dependency changes | Tests, Security (2)                             | Bug fix, typo, config change                      |
| **Medium** | 4-10 files or 51-300 lines, or new files, or modified deps           | + Architecture, Dependencies, Code Quality (5)  | New feature, partial refactor                     |
| **Large**  | > 10 files or > 300 lines, or UI changes, or new modules             | + Performance, Accessibility, Documentation (8) | New module, architectural change, feature with UI |

#### Automatic scaling

The tier can **scale up** during execution. If a Small tier agent detects a serious problem, the Core can decide to scale to Medium or Large:

```
Small (Tests + Security)
  │
  ├── Tests: ✅ passes  →  stays at Small
  │
  └── Security: ❌ finds critical vulnerability
       → Scale to Medium (add Architecture, Dependencies, Code Quality)
       → Re-evaluate if Large is needed
```

#### Tier configuration

```yaml
pipeline:
  tiers:
    small:
      max_files: 3
      max_lines: 50
      max_new_files: 0
      agents: [tests, security]
    medium:
      max_files: 10
      max_lines: 300
      agents: [tests, security, architecture, dependencies, code_quality]
    large:
      agents:
        [
          tests,
          security,
          architecture,
          dependencies,
          code_quality,
          performance,
          accessibility,
          documentation,
        ]
  tier_override: null # Force a specific tier (ignores classification)
```

A client can also force the tier in the request:

```json
{
  "branch": "feature/auth",
  "worktree_path": "/path/to/worktree",
  "config": {
    "tier_override": "large"
  }
}
```

#### Execution diagram (with tier and containers)

```
PipelineRequest received
         │
         ▼
Classify change → tier = medium
         │
         ▼
┌─────────────────────────────────────┐
│  Step 0: Container Infrastructure   │
│                                     │
│  ALWAYS:                            │
│    Sandbox container (Podman)       │
│    → copy worktree → git clone      │
│    → spawnFn = podman exec          │
│                                     │
│  compose.yml in worktree?           │
│    Yes → podman compose up          │
│          → health check             │
│          → Playwright CDP browser   │
│          → mcpServers = { cdp-browser }
│    No  → mcpServers = undefined     │
│          (sandbox ready, no browser)│
└─────────────┬───────────────────────┘
              │
              ▼
   ONE AGENT (inside sandbox via podman exec)
   launches 5 sub-agents (tier medium)
   with mcpServers injected (if project containers exist)
         │
    ┌────┼────┬────┬────┬────┐
    │    │    │    │    │    │
    ▼    ▼    ▼    ▼    ▼    ▼    (all in parallel)
┌──────┐┌──────┐┌──────┐┌──────┐┌──────┐
│Tests ││Secur.││Archi.││Deps. ││Code Q│
│ 🌐  ││      ││      ││      ││      │  🌐 = uses browser tools
└──┬───┘└──┬───┘└──┬───┘└──┬───┘└──┬───┘
   │       │       │       │       │
   └───────┴───────┴───────┴───────┘
                     │
                     ▼
           Agent consolidates results
                     │
              ┌──────┴──────┐
              │             │
           ✅ PASSES     ❌ FAILS
              │             │
              ▼             ▼
        Emits event    Auto-correction
        pipeline.      on branch
        completed      pipeline/{branch}
              │             │
              └──────┬──────┘
                     ▼
           Cleanup: containers + browser
           (containerManager.cleanup)
```

### 7.1 Tests Agent [BLOCKING] — Tier: Small

Verifies that the code works correctly.

- Runs the existing test suite
- Verifies that no regressions were introduced
- Evaluates code coverage on modified lines
- Suggests missing tests for new code

**Blocking criteria:** Any failing test.

### 7.2 Security Agent [BLOCKING] — Tier: Small

Analyzes security vulnerabilities.

- SQL injection, XSS, command injection (OWASP Top 10)
- Secret handling and exposed credentials
- Input validation at system boundaries
- Dependencies with known CVEs

**Blocking criteria:** CRITICAL or HIGH severity vulnerability.

### 7.3 Architecture Agent [BLOCKING] — Tier: Medium

Evaluates code design and structure.

- SOLID principles and project patterns
- Coupling between modules
- Component cohesion
- Introduced technical debt
- Quality attributes (maintainability, extensibility)

**Blocking criteria:** Violation of the project's architectural principles.

### 7.4 Performance Agent [WARNING] — Tier: Large

Detects performance problems.

- Inefficient algorithms (unnecessary O(n^2))
- Potential memory leaks
- N+1 database queries
- Blocking operations on critical paths

**Blocking criteria:** Does not block. Reports warnings.

### 7.5 Dependencies Agent [BLOCKING] — Tier: Medium

Audits the project's dependencies.

- Licenses incompatible with the project
- Known vulnerabilities (CVEs)
- Abandoned or unmaintained dependencies
- Unnecessary dependencies

**Blocking criteria:** Critical CVE or incompatible license.

### 7.6 Code Quality Agent [WARNING] — Tier: Medium

Goes beyond linting — understands the project's context.

- Consistency with the project's naming conventions
- Introduced duplicate code
- Excessive cyclomatic complexity
- Patterns that differ from the rest of the codebase

**Blocking criteria:** Does not block. Reports warnings.

### 7.7 Accessibility Agent [CONDITIONAL] — Tier: Large

Activates only when there are UI changes.

- Color contrast (WCAG AA/AAA)
- Keyboard navigation
- Screen reader compatibility
- ARIA labels and semantic roles

**Blocking criteria:** Blocks only if there are WCAG level A violations.

### 7.8 Documentation Agent [WARNING] — Tier: Large

Verifies that documentation accompanies the code.

- README updated if the public API changed
- Changelog for breaking changes
- Docstrings on new public functions
- Updated diagrams if the architecture changed

**Blocking criteria:** Does not block. Reports suggestions.

### 7.9 Container Infrastructure and Browser Tools

The pipeline integrates a **Step 0 for infrastructure** that has two layers: a **mandatory sandbox container** where the agent runs, and **optional project containers** with browser tools. This happens **before** the agents start.

#### Two container layers

| Layer                                | Mandatory                                                        | What it does                                                                                                                                   |
| ------------------------------------ | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **Sandbox** (SandboxManager)         | **Yes** — Podman is required. Without Podman the pipeline fails. | Creates an isolated container where the Claude agent runs. The worktree files are copied to the container and a fresh git repo is initialized. |
| **Project** (ContainerService + CDP) | No — only if `compose.yml` exists                                | Starts the project services (app, DB, etc.), waits for health checks, and creates a headless browser (Playwright CDP) with MCP tools.          |

#### Container Architecture

```
@funny/core/containers (library)          @funny/agent (orchestration)
┌──────────────────────────────┐              ┌────────────────────────────────┐
│ SandboxManager               │              │ ContainerManager               │
│  - isPodmanAvailable()       │◄─────────────│  - setup(worktreePath, reqId)  │
│  - ensureImage()             │              │  - cleanup(worktreePath, reqId)│
│  - startSandbox()            │              │  - cleanupAll()                │
│  - createSpawnFn()           │              │  - killOrphans()               │
│  - stopSandbox()             │              │                                │
│  - killOrphans()             │              │ Maintains instance map:        │
│                              │              │ cdpInstances: Map<path, CDP>   │
│ ContainerService             │              │                                │
│  - detectComposeFile()       │◄─────────────│ Injected into PipelineRunner   │
│  - startContainers()         │              └────────────────────────────────┘
│  - waitForHealthy()          │
│  - stopContainers()          │
│                              │
│ createCdpMcpServer()         │
│  - Playwright headless Chrome│
│  - MCP tools (cdp_*)         │
└──────────────────────────────┘
```

- **`@funny/core/containers`** — Reusable library. Contains `SandboxManager`, `ContainerService`, and `createCdpMcpServer`.
- **`ContainerManager`** — Pipeline-specific orchestration. Lives in `packages/agent/src/infrastructure/`.

#### Step 0 Flow

```
PipelineRunner.run(request)
         │
         ▼
  containerManager.setup(worktree_path, request_id)
         │
         ├── 1. Verify Podman available (MANDATORY)
         │      → If not installed → throw Error with installation instructions
         │
         ├── 2. Create sandbox container (ALWAYS)
         │      → podman build (funny-sandbox image, lazy, once only)
         │      → podman run -d (mount worktree read-only at /mnt/source)
         │      → Copy files (excluding .git) to /workspace
         │      → Initialize fresh git repo:
         │         a. git init + git remote add origin
         │         b. git fetch origin {branch} --depth=50
         │         c. git checkout -b {branch} FETCH_HEAD
         │         (fallback: git init + git add -A + git commit)
         │      → createSpawnFn(requestId) → custom spawn function
         │         (the Claude agent runs inside the container via podman exec)
         │
         ├── 3. Detect compose file (OPTIONAL)
         │      → Looks for compose.yml, compose.yaml, docker-compose.yml
         │      → If NONE exists → return (sandbox ready, no browser)
         │
         ├── 4. Start project services (if compose exists)
         │      → podman compose up -d
         │      → waitForHealthy() → HTTP poll
         │
         ├── 5. Find app URL from the first exposed port
         │      → http://localhost:{firstPort}
         │
         └── 6. createCdpMcpServer({ appUrl })
                → Launches Playwright headless Chrome
                → Navigates to appUrl
                → Creates MCP server with 3 tools:
                   • cdp_navigate(url) — Navigate to a URL
                   • cdp_screenshot() — Screen capture (PNG)
                   • cdp_get_dom(selector?) — Get HTML/DOM
                → Returns { server } to inject into mcpServers
```

#### Copy + Clone Strategy

The sandbox **doesn't use bind-mounts** for the worktree. Instead:

1. The host worktree is mounted **read-only** at `/mnt/source`
2. The files (excluding `.git`) are **copied** to `/workspace` inside the container
3. A **fresh git repo** is initialized: `git init` → `git remote add origin` → `git fetch --depth=50` → `git checkout`

**Why not bind-mount?**

- Avoids permission issues between host and container
- Avoids cross-platform path issues (Windows <-> Linux)
- Git worktrees have a `.git` pointer file (not a directory), and bind-mounting this doesn't work correctly inside a container
- The container has its own `.git` directory with real history

**Fallback:** If there's no remote URL or the fetch fails, a local `git init` with all files committed as a snapshot is used.

#### Injection into Agents

The `spawnClaudeCodeProcess` and optionally `mcpServers` are passed to `orchestrator.startAgent()`. The Claude SDK agent runs **inside the sandbox** via `podman exec`, and receives browser tools via MCP if there are project containers:

```
orchestrator.startAgent({
  prompt: buildPipelinePrompt(..., hasBrowserTools: true),
  cwd: '/workspace',                                   // ← inside the container
  spawnClaudeCodeProcess: sandboxSpawnFn,               // ← podman exec wrapper
  mcpServers: { 'cdp-browser': cdp.server },            // ← only if compose exists
  ...
})
```

When `hasBrowserTools` is `true`, the prompt includes an additional section:

```
## Browser Tools Available
The application is running in a container. You have access to browser automation tools via MCP:
- `cdp_navigate` — Navigate the browser to a URL
- `cdp_screenshot` — Take a screenshot of the current page (returns PNG image)
- `cdp_get_dom` — Get the HTML/DOM of the page or a specific CSS selector

Use these tools for E2E testing, accessibility checks, visual verification, and performance inspection.
```

#### Agents that use Browser Tools

| Agent             | Browser usage                  | Example                                     |
| ----------------- | ------------------------------ | ------------------------------------------- |
| **Tests**         | E2E testing, visual regression | `cdp_navigate` → `cdp_screenshot` → compare |
| **Security**      | Verify CSP headers, XSS        | `cdp_navigate` → inspect response           |
| **Accessibility** | WCAG compliance, ARIA          | `cdp_get_dom` → analyze semantic structure  |
| **Performance**   | Load time, rendering           | `cdp_navigate` → measure load time          |
| **Style**         | Visual consistency             | `cdp_screenshot` → verify layout            |
| Others            | As needed                      | Any agent can use the tools                 |

#### Cleanup

Containers and the browser are cleaned up at three points:

1. **Pipeline completes/fails/stops** — Event listener in `index.ts` listens for `pipeline.completed`, `pipeline.failed`, `pipeline.stopped` and calls `containerManager.cleanup(worktreePath, requestId)` with a 3-second delay (to let the SDK process terminate cleanly)
2. **Service shutdown** — On `SIGINT`/`SIGTERM`, `containerManager.cleanupAll()` is called which disposes all CDP instances, stops project containers, and stops all sandboxes
3. **Service startup** — `containerManager.killOrphans()` finds and removes orphaned `pipeline-sandbox-*` containers from previous executions (crashes, closed terminals)

```
pipeline.completed / pipeline.failed / pipeline.stopped
         │
         ▼ (3s delay for SDK to finish)
containerManager.cleanup(worktreePath, requestId)
         │
         ├── cdp.dispose()          → Closes Playwright browser
         ├── stopContainers()       → podman compose down (project)
         └── stopSandbox(requestId) → podman rm -f (sandbox)
```

#### Degradation: Sandbox mandatory, Project optional

The **sandbox is mandatory**. If Podman is not installed, `setup()` throws an error with installation instructions and the pipeline **cannot run**.

**Project containers are optional**. If any step of the project setup fails (compose file doesn't exist, health check timeout, Playwright fails), the pipeline **continues without browser tools**. Agents can still run their normal static checks inside the sandbox.

```typescript
// In ContainerManager.setup():
// 1. Sandbox — MANDATORY (throw if fails)
const podmanAvailable = await this.sandboxManager.isPodmanAvailable();
if (!podmanAvailable) {
  throw new Error('Podman is required to run pipelines...');
}
await this.sandboxManager.startSandbox({ requestId, worktreePath });

// 2. Project — OPTIONAL (catch + warn if fails)
try {
  const composeFile = await this.containerService.detectComposeFile(worktreePath);
  if (composeFile) {
    // ... start containers, wait for health, create CDP browser
  }
} catch (err) {
  logger.warn('Project container setup failed — continuing without browser tools');
}
```

### Skills that implement each agent

| Agent         | Tier   | Skill                                       | Status    |
| ------------- | ------ | ------------------------------------------- | --------- |
| Tests         | Small  | `anthropics/skills@webapp-testing`          | Available |
| Security      | Small  | `security-audit`                            | Installed |
| Architecture  | Medium | `architecture-eval`                         | Installed |
| Dependencies  | Medium | `jezweb/claude-skills@dependency-audit`     | Available |
| Code Quality  | Medium | `tursodatabase/turso@code-quality`          | Available |
| Performance   | Large  | `addyosmani/web-quality-skills@performance` | Available |
| Accessibility | Large  | `web-design-guidelines`                     | Installed |
| Documentation | Large  | Custom (to be created)                      | Pending   |

---

## 8. The Director Agent (Coordinator)

The Director doesn't touch code. It doesn't "discover" worktrees. **It reacts to events and reads the manifest to know what's ready.**

### How the Director is activated

The Director doesn't need to be running permanently. It's activated by events:

```
                                    ┌──────────────────────┐
                                    │   DIRECTOR AGENT      │
                                    │                       │
  pipeline.completed ──────────────►│ 1. Reads manifest.json│
  (via Event Bus)                   │ 2. Filters eligible   │
                                    │ 3. Resolves deps      │
          or                        │ 4. Orders by priority │
                                    │ 5. Dispatches Integr. │
  Manual trigger ──────────────────►│                       │
  (CLI: pipeline director run)      └───────────┬───────────┘
                                                │
          or                                    ▼
                                    Dispatches to the Integrator
  Cron/scheduler ──────────────────►  for each eligible branch
  (every N minutes)
```

**Three ways to activate the Director:**

| Method           | How it works                                                                  | When to use                                                        |
| ---------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| **Event-driven** | An outbound adapter listens to `pipeline.completed` and launches the Director | Automated flow. The Director runs only when there's something new. |
| **Manual**       | `pipeline director run` from the terminal                                     | Debugging, manual control.                                         |
| **Scheduled**    | A cron job that runs `pipeline director run` every N minutes                  | As a fallback, in case an event was lost.                          |

### The Manifest (.pipeline/manifest.json)

The manifest is the **source of truth** for the state of all branches. Not only the Director reads it — it's what allows the entire system to know where each branch is at any given moment.

The manifest has **three lists** that represent the lifecycle of a branch:

```
ready[]          → Pipeline approved. Waiting for the Director to dispatch to the Integrator.
pending_merge[]  → PR created on GitHub. Waiting for human approval.
merge_history[]  → PR merged to main. Completed.
```

#### State machine of a branch

```
                    POST /pipeline/run
                           │
                           ▼
                    ┌──────────────┐
                    │  (pipeline   │       The manifest does NOT track this state.
                    │   running)   │       The Core manages it via events.
                    │              │
                    └──────┬───────┘
                           │
                    ┌──────┴───────┐
                    │              │
                 ✅ approved    ❌ failed → (outside the manifest, requires intervention)
                    │
                    ▼
             ┌─────────────┐
             │   ready[]    │    Manifest Writer writes here
             │              │    Director reads and dispatches
             └──────┬───────┘
                    │
                    │ Director dispatches → Integrator creates PR
                    ▼
          ┌──────────────────┐
          │  pending_merge[] │    PR open on GitHub
          │                  │    Waiting for human approval
          │  (has pr_number  │
          │   and pr_url)    │    If main advances → Integrator rebases the PR
          └──────┬───────────┘
                 │
                 │ Human approves and merges the PR (GitHub webhook)
                 ▼
          ┌──────────────────┐
          │  merge_history[] │    Completed. Branch integrated into main.
          │                  │    pipeline/ and integration/ branches are cleaned up
          └──────────────────┘
```

#### Complete manifest structure

```json
{
  "manifest": {
    "main_branch": "main",
    "main_head": "abc123def",
    "last_updated": "2026-02-14T12:10:00Z",

    "ready": [
      {
        "branch": "feature/auth",
        "pipeline_branch": "pipeline/feature/auth",
        "worktree_path": "../project-auth",
        "request_id": "abc-123",
        "pipeline_result": {
          "tests": { "status": "pass", "details": "25/25" },
          "security": { "status": "pass", "details": "Corrected: token expiration" },
          "architecture": { "status": "pass", "details": "OK" },
          "performance": { "status": "warning", "details": "O(n^2) in utils.ts:45" },
          "dependencies": { "status": "pass", "details": "All OK" },
          "code_quality": { "status": "pass", "details": "Consistent" },
          "accessibility": { "status": "skipped", "details": "No UI changes" },
          "documentation": { "status": "warning", "details": "README outdated" }
        },
        "corrections_applied": ["security: added expiresIn to JWT token"],
        "ready_at": "2026-02-14T12:00:00Z",
        "priority": 1,
        "depends_on": [],
        "metadata": {
          "triggered_by": "my-app",
          "task_id": "TASK-123"
        }
      }
    ],

    "pending_merge": [
      {
        "branch": "feature/api",
        "pipeline_branch": "pipeline/feature/api",
        "integration_branch": "integration/feature/api",
        "request_id": "def-456",
        "pr_number": 43,
        "pr_url": "https://github.com/org/repo/pull/43",
        "pr_created_at": "2026-02-14T12:06:00Z",
        "base_main_sha": "abc123def",
        "pipeline_result": { "...": "..." },
        "corrections_applied": [],
        "priority": 2,
        "depends_on": [],
        "metadata": {
          "triggered_by": "my-app",
          "task_id": "TASK-456"
        }
      }
    ],

    "merge_history": [
      {
        "branch": "feature/setup",
        "pr_number": 41,
        "commit_sha": "789xyz",
        "merged_at": "2026-02-14T11:50:00Z",
        "metadata": {
          "task_id": "TASK-100"
        }
      }
    ]
  }
}
```

**Key fields in `pending_merge`:**

| Field                  | Purpose                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------ |
| `integration_branch`   | Branch used for the PR. The Integrator needs it to rebase if main advances.                |
| `pr_number` / `pr_url` | Reference to the PR on GitHub. For tracking and for updating the PR if needed.             |
| `base_main_sha`        | The SHA of main when the PR was created. Allows detecting if main has advanced since then. |

### Director responsibilities

1. **Read** the manifest to know the state of all branches
2. **Validate** that pipeline results are acceptable (all blocking agents in "pass")
3. **Resolve dependencies** — if a branch depends on another that's not yet in `merge_history`, don't process it
4. **Order** by priority those that are ready and have no pending dependencies
5. **Dispatch** to the Integration Agent to create PRs
6. **Detect stale PRs** — when main advances, check if PRs in `pending_merge` need rebase
7. **Update** the manifest by moving entries between `ready`, `pending_merge`, and `merge_history`
8. **Clean up branches** — delete `pipeline/*` and `integration/*` after completion
9. **Emit events** — on each state transition

### Director logic

The Director is activated for three different reasons, and the logic changes based on the trigger:

```
ACTIVATION BY pipeline.completed (new pipeline approved):

1. Read .pipeline/manifest.json
2. Filter "ready" entries:
   a. Verify that all blocking agents are in "pass"
   b. Verify dependencies: are the branches in depends_on already in merge_history?
      - Yes → eligible
      - No → skip (wait)
3. Order eligible by priority
4. For each eligible:
   → Emit director.integration.dispatched { branch }
   → Dispatch to the Integration Agent
   → When PR is created, move from "ready" to "pending_merge"
   → Save base_main_sha = current HEAD of main
   → Emit director.integration.pr_created { branch, pr_number }
5. If none eligible → emit director.cycle.completed { reason: "nothing_ready" }
```

```
ACTIVATION BY integration.pr.merged (a PR was merged by human):

1. Read .pipeline/manifest.json
2. Move the branch from "pending_merge" to "merge_history"
3. Record commit_sha and merged_at
4. Clean up branches:
   → git branch -d pipeline/{branch}
   → git branch -d integration/{branch}
   → git push origin --delete pipeline/{branch}
   → git push origin --delete integration/{branch}
5. Check for stale PRs in "pending_merge":
   → For each entry in pending_merge:
      → If base_main_sha != current HEAD of main:
         → The PR is based on an old main
         → Dispatch to Integrator for PR rebase
         → Emit director.pr.rebase_needed { branch, pr_number }
6. Check if there are new branches in "ready" whose dependencies are now satisfied
   → If feature/ui depended on feature/api and feature/api was just merged
   → Now feature/ui is eligible → dispatch to the Integrator
7. Emit director.cycle.completed { merged: [...], rebased: [...], dispatched: [...] }
```

```
MANUAL or SCHEDULED ACTIVATION (reconciliation):

1. Read .pipeline/manifest.json
2. Check consistency:
   → Are there PRs in "pending_merge" that were already closed on GitHub? → Move to "ready" (retry)
   → Are there PRs in "pending_merge" with an old base_main_sha? → Rebase
   → Are there eligible branches in "ready" that weren't processed? → Dispatch
   → Are there orphaned pipeline/* or integration/* branches? → Clean up
3. Emit director.cycle.completed with summary
```

### Director events

| Event                             | When emitted                                               | Data                                                                   |
| --------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------- |
| `director.activated`              | The Director begins a cycle                                | `{ trigger, manifest_entries: N }`                                     |
| `director.integration.dispatched` | A branch is dispatched to the Integrator                   | `{ branch, priority }`                                                 |
| `director.integration.pr_created` | The Integrator created a PR for the branch                 | `{ branch, pr_number, pr_url }`                                        |
| `director.pr.rebase_needed`       | A PR became outdated because main advanced                 | `{ branch, pr_number, old_base, new_base }`                            |
| `director.pr.rebased`             | The Integrator updated a stale PR                          | `{ branch, pr_number }`                                                |
| `director.branch.cleaned`         | A temporary branch was deleted (pipeline/ or integration/) | `{ branch, type }`                                                     |
| `director.cycle.completed`        | The Director finished its cycle                            | `{ merged: [...], rebased: [...], dispatched: [...], cleaned: [...] }` |

These events also flow through the Event Bus. Outbound adapters can react — for example, the Client Notifier can notify the client that the task is in "PR Created" when it sees `integration.pr.created` and in "Done" when it sees `integration.pr.merged`.

### Who writes to the manifest

```
Pipeline Core finishes
       │
       ▼
Emits pipeline.completed (or pipeline.failed)
       │
       ▼
  ┌────┴────┐
  │         │
✅ approved ❌ not approved
  │         │
  ▼         ▼
Manifest    Nothing is written
Writer      to the manifest.
writes      The Director never
to the      finds out.
manifest    Requires manual
  │         intervention.
  ▼
Director sees it
on its next activation
```

**Key rule:** Only the Manifest Writer writes to the manifest, and only when `approved: true`. If the pipeline fails, the manifest is not touched. The Director never sees branches with problems.

---

## 9. The Integration Agent (PR Creator)

Takes approved branches and **creates Pull Requests toward main**. It's the only one that prepares code for the main branch. The final merge requires human approval.

### Responsibilities

1. **Prepare integration branch** — `integration/{branch}` based on main with the merged changes
2. **Resolve conflicts** automatically (semantic, not just textual)
3. **Deduplicate** code when two branches created similar functionality
4. **Re-run pipeline** on the merge result to verify integrity
5. **Create Pull Request** toward main with a complete summary of pipeline results
6. **Tag the PR** with labels based on the result (auto-corrected, conflicts-resolved, clean)
7. **Update stale PRs** — when main advances, rebase the `integration/` branch and force-push to update the PR
8. **Clean up branches** — delete `pipeline/{branch}` and `integration/{branch}` after the PR is merged

### Integration Flow via Pull Request

```
Merge Queue: [feature/auth (P1), feature/ui (P3)]
                    │
                    ▼
        ┌─── feature/auth ───────────────────────┐
        │                                         │
        │  1. Create integration/feature/auth     │
        │     branch based on main                │
        │       │                                 │
        │  2. Merge pipeline/feature/auth         │
        │     into integration/feature/auth       │
        │       │                                 │
        │  ┌────┴────┐                            │
        │  │         │                            │
        │ No       With                           │
        │ conflict conflict                       │
        │  │         │                            │
        │  │    Resolve                           │
        │  │    (semantic)                        │
        │  │         │                            │
        │  └────┬────┘                            │
        │       │                                 │
        │  3. Pipeline on merge result            │
        │       │                                 │
        │    ✅ Passes                              │
        │       │                                 │
        │  4. Push integration/feature/auth       │
        │       │                                 │
        │  5. gh pr create                        │
        │     --base main                         │
        │     --head integration/feature/auth     │
        │     --title "Integrate: feature/auth"   │
        │     --body "{summary of 8 agents}"      │
        │       │                                 │
        │  6. Emit integration.pr.created         │
        │     { pr_number, pr_url }               │
        │                                         │
        └───────┬─────────────────────────────────┘
                │
                ▼
        PR open, waiting for human approval
                │
                ▼ (human approves and merges)
                │
        main updated
                │
                ▼
        ┌─── feature/ui ────────────────────────┐
        │                                        │
        │  1. Create integration/feature/ui      │
        │     branch based on main (already      │
        │     has auth)                          │
        │       │                                │
        │  2. Merge pipeline/feature/ui          │
        │       │                                │
        │  Detect duplication                    │
        │       │                                │
        │  ┌────┴────┐                           │
        │  │         │                           │
        │ No       With                          │
        │ duplic.  duplic.                       │
        │  │         │                           │
        │  │    Deduplicate                      │
        │  │    (unify)                          │
        │  │         │                           │
        │  └────┬────┘                           │
        │       │                                │
        │  3. Pipeline on merge result           │
        │       │                                │
        │    ✅ Passes                             │
        │       │                                │
        │  4. Push + gh pr create                │
        │       │                                │
        │  5. Emit integration.pr.created        │
        │                                        │
        └────────────────────────────────────────┘
```

**Note:** The Integrator merges the `pipeline/{branch}` branch (which has the pipeline corrections), not the developer's original branch.

### Pull Request Content

The Integrator generates a PR with complete information to facilitate human review:

```markdown
## Integrate: feature/auth

### Pipeline Summary

| Agent         | Result     | Details               |
| ------------- | ---------- | --------------------- |
| Tests         | ✅ Pass    | 25/25 tests           |
| Security      | ✅ Pass    | Auto-corrected        |
| Architecture  | ✅ Pass    | SOLID OK              |
| Performance   | ⚠️ Warning | O(n^2) in utils.ts:45 |
| Dependencies  | ✅ Pass    | All OK                |
| Code Quality  | ✅ Pass    | Consistent            |
| Accessibility | ⏭️ Skipped | No UI changes         |
| Documentation | ⚠️ Warning | README outdated       |

### Automatic Corrections

- **Security**: Added `expiresIn: '1h'` to JWT token

### Conflicts Resolved

- None

### Post-Merge Pipeline

✅ Pipeline passed on the merge result with main

---

🤖 Generated by Pipeline Service | Request ID: abc-123
```

### Integration branch

The Integrator doesn't merge directly to main. It creates an intermediate branch:

| Branch                     | Purpose                                                     |
| -------------------------- | ----------------------------------------------------------- |
| `feature/auth`             | Developer's original branch                                 |
| `pipeline/feature/auth`    | Branch where the pipeline ran + corrections                 |
| `integration/feature/auth` | Branch prepared for PR (pipeline/ merged onto current main) |

This allows the PR to show a clean diff against current main, including all pipeline corrections.

### Types of Problems It Resolves

**1. File Conflicts**

Two worktrees modified the same file on the same lines.

```
Worktree A: modified auth.ts lines 45-50
Worktree C: modified auth.ts lines 47-52
→ Resolution: semantic analysis of both changes, intelligent merge
```

**2. Logic Duplication**

Two worktrees created equivalent functionality with different names.

```
Worktree A: created validateEmail() in utils.ts
Worktree C: created isValidEmail() in helpers.ts
→ Resolution: keep one, redirect imports, delete duplicate
```

**3. Contradictory Dependencies**

Two worktrees added the same dependency in different versions.

```
Worktree A: added lodash@4.17
Worktree C: added lodash@4.18
→ Resolution: use the most recent compatible version
```

**4. Conflicting Migrations**

Two worktrees created migrations with the same sequence number.

```
Worktree A: migration_005_add_users
Worktree C: migration_005_add_products
→ Resolution: renumber one to migration_006
```

### Integrator events

| Event                              | When emitted                               | Data                                             |
| ---------------------------------- | ------------------------------------------ | ------------------------------------------------ |
| `integration.started`              | Started preparing a branch                 | `{ branch, integration_branch, target: "main" }` |
| `integration.conflict.detected`    | Detected a conflict                        | `{ branch, files, type }`                        |
| `integration.conflict.resolved`    | Resolved a conflict                        | `{ branch, files, resolution }`                  |
| `integration.duplication.detected` | Detected duplicate code                    | `{ branch, functions, files }`                   |
| `integration.duplication.resolved` | Deduplicated                               | `{ branch, kept, removed }`                      |
| `integration.pipeline.running`     | Re-running pipeline post-merge             | `{ branch }`                                     |
| `integration.pr.created`           | PR created toward main                     | `{ branch, pr_number, pr_url, pr_title }`        |
| `integration.pr.rebased`           | PR updated because main advanced           | `{ branch, pr_number, old_base, new_base }`      |
| `integration.pr.merged`            | PR merged by human (GitHub webhook)        | `{ branch, pr_number, commit_sha }`              |
| `integration.cleanup`              | Temporary branches deleted                 | `{ pipeline_branch, integration_branch }`        |
| `integration.completed`            | Integration complete (PR merged + cleanup) | `{ branch, commit_sha, pr_number }`              |
| `integration.failed`               | PR preparation failed                      | `{ branch, reason }`                             |

### Updating PRs when main advances

When a PR is merged to main, the other open PRs are based on an old main. The Integrator updates them:

```
PR #42 (feature/auth) merges to main
         │
         │  main advanced: abc123 → def456
         │
         ▼
Director detects: PR #43 (feature/api) has base_main_sha = abc123
         │
         ▼
Integrator rebase:
  1. git checkout integration/feature/api
  2. git rebase main
     ┌────┴────┐
     │         │
   No        With
   conflict  conflict
     │         │
     │    Resolve (semantic)
     │         │
     └────┬────┘
          │
  3. Re-run pipeline on result
  4. git push --force-with-lease origin integration/feature/api
  5. Update PR body if there were changes
  6. Update base_main_sha in manifest
  7. Emit integration.pr.rebased { pr_number: 43 }
```

**`--force-with-lease`** instead of `--force`: protects against concurrent pushes. If someone pushed to the branch between the rebase and the push, the command fails instead of overwriting.

### Branch cleanup

The pipeline generates temporary branches that must be deleted when no longer needed:

```
Event                              Cleanup action
─────────────────────────────   ──────────────────────────────────────
pipeline.completed              → Delete pipeline/{branch} (after merge back)
  (if merge_back: true)           Only if approved: true

integration.pr.merged           → Delete integration/{branch} (local + remote)
  (GitHub webhook)                → Delete pipeline/{branch} if still exists

pipeline.failed                 → Keep pipeline/{branch} if keep_on_failure: true
  (for debugging)                 → Delete after N days (stale_branch_days)
```

The Director executes the cleanup as part of its cycle when it receives `integration.pr.merged`. It's not the Integrator's responsibility — the Director has the global view.

---

## 10. Auto-Correction Flow

When the pipeline detects blocking problems, the Core corrects them automatically **on the `pipeline/{branch}` branch**.

```
┌─────────────────────────────────────────────────────────┐
│                                                         │
│  Branch: pipeline/feature/auth                          │
│                                                         │
│         ┌───────────────────┐                           │
│         │                   │                           │
│         ▼                   │                           │
│   Run 8 agents              │                           │
│   in parallel               │                           │
│         │                   │                           │
│    ┌────┴────┐              │                           │
│    │         │              │                           │
│ ✅ Passes ❌ Fails ──► Correct on pipeline/{branch}     │
│    │              (commit corrections)                   │
│    │              (max 3 attempts)                       │
│    │                        │                           │
│    ▼                        │                           │
│ Emit pipeline.completed     │                           │
│ { approved: true }          │                           │
│    │                                                    │
│    ▼                                                    │
│ Merge back: pipeline/{branch} → {branch}                │
│ (the corrections return to the original branch)         │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### Auto-correction rules

1. **Maximum 3 attempts** — Prevents infinite loops
2. **Only re-runs agents that failed** — Doesn't repeat unnecessary work
3. **Each correction generates a commit on `pipeline/{branch}`** — Complete traceability
4. **If it can't correct** — Emits `pipeline.failed` with detailed diagnostics
5. **Correction commits** — Have standard format: `fix(pipeline): {description of fix}`

### Events during auto-correction

Each step of auto-correction emits events, allowing outbound adapters to show progress in real time:

```
pipeline.round.completed     { round: 1, blocking_failures: ["security"] }
pipeline.correction.started  { attempt: 1, agent: "security", issue: "Token without expiration" }
pipeline.correction.completed { attempt: 1, agent: "security", success: true }
pipeline.agent.completed     { agent: "security", status: "pass" }
pipeline.round.completed     { round: 2, blocking_failures: [] }
pipeline.completed           { approved: true }
```

An outbound adapter (like the Client Notifier) can use these events to send progress to the client:

```
Card TASK-123:
  Status: Pipeline Running
  Progress:
    Round 1: 7/8 passed, 1 failed (security)
    Auto-correcting: security (attempt 1/3)
    Round 2: 8/8 passed ✅
  Result: Approved
```

---

## 11. Pipeline Execution Timing

### When it triggers

The pipeline triggers when an external system sends a `PipelineRequest` through an inbound adapter. The typical moments are:

| Trigger                        | Description                                                  | Inbound Adapter        |
| ------------------------------ | ------------------------------------------------------------ | ---------------------- |
| **Request from a web service** | An external service sends a worktree to process              | REST API               |
| **PR opened/updated**          | A Pull Request is opened or updated                          | Webhook Adapter        |
| **Manual command**             | `pipeline run --branch feature/auth`                         | CLI Adapter            |
| **Agent finishes task**        | A Claude Code agent finishes its work and calls the pipeline | MCP Adapter            |
| **Scheduled**                  | A cron job that runs the pipeline on active branches         | CLI Adapter (via cron) |

### Complete flow from trigger

```
                           HERE
                            │
  External system ─► Adapter ─► Core ─► [Create pipeline/{branch}] ─► [8 agents] ─► Events
                                                                                       │
                                                                              ┌────────┴────────┐
                                                                              │                 │
                                                                        ✅ Approved        ❌ Failed
                                                                              │                 │
                                                                     Manifest Writer      Only events
                                                                     writes to manifest   (outbound adapters
                                                                              │            notify)
                                                                              ▼
                                                                     Director processes it
                                                                     on its next activation
```

### Runs on all tasks, but not always all 8 agents

The pipeline always runs — no branch skips the process. But the number of agents depends on the tier of the change:

| Tier           | Agents                                      | When                                         |
| -------------- | ------------------------------------------- | -------------------------------------------- |
| **Small** (2)  | Tests, Security                             | Bug fix, config change, minor changes        |
| **Medium** (5) | + Architecture, Dependencies, Code Quality  | New feature, refactor                        |
| **Large** (8)  | + Performance, Accessibility, Documentation | New module, UI changes, architectural change |

The classification is automatic (based on `git diff --stat`), but the client can force it with `tier_override` in the request. Tests and Security always run — they are the non-negotiable minimum.

---

## 12. Per-Project Configuration

```yaml
pipeline:
  # Pipeline branch
  branch:
    prefix: 'pipeline/' # Prefix for pipeline branches
    merge_back: true # Merge corrections back to the original branch
    delete_after_merge: true # Delete pipeline/ branch after successful merge
    keep_on_failure: true # Keep pipeline/ branch on failure (for debugging)

  # Execution tiers
  tiers:
    small:
      max_files: 3 # Modified files
      max_lines: 50 # Changed lines
      max_new_files: 0 # New files
      agents: [tests, security]
    medium:
      max_files: 10
      max_lines: 300
      agents: [tests, security, architecture, dependencies, code_quality]
    large: # Everything exceeding medium
      agents:
        [
          tests,
          security,
          architecture,
          dependencies,
          code_quality,
          performance,
          accessibility,
          documentation,
        ]
  tier_override: null # Force tier: "small" | "medium" | "large" | null (auto)

  # The 8 quality agents
  agents:
    tests:
      enabled: true
      blocking: true
      tier: small # Always runs

    security:
      enabled: true
      blocking: true
      tier: small # Always runs

    architecture:
      enabled: true
      blocking: true
      tier: medium

    performance:
      enabled: true
      blocking: false
      tier: large

    dependencies:
      enabled: true
      blocking: true
      tier: medium

    code_quality:
      enabled: true
      blocking: false
      tier: medium

    accessibility:
      enabled: true
      blocking: conditional # Only blocks WCAG level A
      tier: large
      condition: 'changes_include_ui'

    documentation:
      enabled: true
      blocking: false
      priority: low

  # Auto-correction
  auto_correction:
    enabled: true
    max_attempts: 3
    allowed_fixes:
      - security_vulnerabilities
      - failing_tests
      - code_style
    manual_only:
      - architectural_changes
      - dependency_upgrades

  # Integration
  integration:
    mode: 'pull-request' # pull-request | auto-merge (PR recommended)
    pr:
      draft: false # Create as draft PR
      labels: # Automatic labels based on result
        - 'pipeline-approved'
        - 'auto-corrected' # Only if there were automatic corrections
        - 'conflicts-resolved' # Only if there were resolved conflicts
      reviewers: [] # Automatic reviewers (GitHub usernames)
      auto_merge: false # Enable GitHub auto-merge if CI passes
    branch_prefix: 'integration/' # Prefix for integration branches
    merge_strategy: 'merge-no-ff' # merge-no-ff | rebase | squash (for the PR)
    deduplication: true
    post_merge_pipeline: true # Re-run pipeline after merge
    rebase_active_worktrees: true # Rebase active worktrees when main changes

  # Event Bus
  event_bus:
    implementation: 'local' # local | redis | nats
    persistence:
      enabled: true
      path: '.pipeline/events/'
      format: 'jsonl'
      retention_days: 30

  # Adapters
  adapters:
    inbound:
      rest_api:
        enabled: true
        port: 3100
        auth: 'bearer-token'
      cli:
        enabled: true
      webhook:
        enabled: false
        path: '/webhooks'
        secret: '${WEBHOOK_SECRET}'
      mcp:
        enabled: true

    outbound:
      manifest_writer:
        enabled: true # Always enabled — this is how the Director finds out
        path: '.pipeline/manifest.json'
      client_notifier:
        enabled: true
        api_url: '${CLIENT_WEBHOOK_URL}'
        auth: 'bearer-token'
        events:
          - 'pipeline.started'
          - 'pipeline.agent.completed'
          - 'pipeline.completed'
          - 'pipeline.failed'
          - 'integration.pr.created'
          - 'integration.pr.merged'
          - 'integration.completed'
      slack_notifier:
        enabled: false
        webhook_url: '${SLACK_WEBHOOK_URL}'
        channel: '#dev'
        events:
          - 'pipeline.completed'
          - 'pipeline.failed'
      github_notifier:
        enabled: false
        events:
          - 'pipeline.completed'
          - 'pipeline.failed'
      webhook_notifier:
        enabled: false
        url: '${CALLBACK_URL}'
        events: ['*'] # All events

  # Director
  director:
    activation: 'event-driven' # event-driven | scheduled | manual
    schedule: '*/5 * * * *' # Only if activation is "scheduled"
    events:
      - 'pipeline.completed' # Activates when a pipeline finishes

  # Resilience
  resilience:
    circuit_breaker:
      claude_code:
        failure_threshold: 3
        reset_timeout_seconds: 60
      github_api:
        failure_threshold: 5
        reset_timeout_seconds: 120
      webhooks:
        failure_threshold: 3
        reset_timeout_seconds: 30
    dead_letter:
      enabled: true
      path: '.pipeline/dlq/'
      max_retries: 5
      backoff: 'exponential'
      base_delay_seconds: 5

  # Sagas
  saga:
    persistence_path: '.pipeline/sagas/'
    cleanup_after_days: 7 # Clean up completed saga logs

  # Logging
  logging:
    level: 'info' # debug | info | warn | error
    path: '.pipeline/logs/'
    retention_days: 30
    per_request: true # File per request_id
    system_log: true # System log (Director, infra)
    console:
      enabled: true
      level: 'info'
      color: true
    sources:
      git: true # Every git command
      github: true # Every GitHub API call
      agents: true # Agent actions
      event_bus: true # Event publishing
      adapters: true # Outbound adapters

  # Reporting
  reporting:
    format: summary # summary | detailed | minimal
    show_warnings: true
    show_suggestions: true
```

---

## 13. Pipeline Service Implementation

### The Pipeline Service as an application

The Pipeline Service is a **Bun application** that runs as the `@funny/agent` package within the monorepo:

1. Starts an HTTP server (Hono) on port 3002 to receive requests
2. Uses `AgentOrchestrator` + `SDKClaudeProcess` from the Claude Agent SDK to execute agents
3. Maintains an Event Bus (eventemitter3) in memory + JSONL persistence on disk
4. Runs outbound adapters (generic webhooks) as internal modules
5. Auto-registers an ingest webhook to forward events to the main UI

```
Pipeline Service (Bun + Hono — packages/agent)
│
├── src/
│   ├── index.ts                       # Composition root — wiring of all components
│   ├── server.ts                      # Bun HTTP server bootstrap + graceful shutdown
│   │
│   ├── routes/
│   │   ├── pipeline.ts                # POST /run, GET /list, GET /:id, GET /:id/events (SSE), POST /:id/stop
│   │   ├── director.ts               # POST /run, GET /status, GET /manifest
│   │   ├── webhooks.ts               # POST /github (inbound GitHub webhook)
│   │   └── logs.ts                    # GET /pipeline/:id, GET /system, GET /requests
│   │
│   ├── core/
│   │   ├── pipeline-runner.ts         # Orchestrates agents via AgentOrchestrator (Claude Agent SDK)
│   │   ├── event-mapper.ts            # CLIMessage → PipelineEvent (stateful, with correction detection)
│   │   ├── state-machine.ts           # Generic FSM + pipeline and branch transitions
│   │   ├── tier-classifier.ts         # git diff --stat → Small/Medium/Large
│   │   ├── prompt-builder.ts          # Builds system prompt for the pipeline agent
│   │   ├── director.ts               # Integration coordinator (no LLM)
│   │   ├── integrator.ts             # Integration saga: fetch → branch → merge → push → PR
│   │   ├── manifest-manager.ts       # Reads/writes .pipeline/manifest.json (ready/pending/history)
│   │   ├── manifest-types.ts          # Manifest types
│   │   ├── branch-cleaner.ts          # Cleanup of pipeline/ and integration/ branches
│   │   └── saga.ts                    # Saga pattern with compensation and persistence
│   │
│   ├── infrastructure/
│   │   ├── event-bus.ts               # eventemitter3 + JSONL persistence per request_id
│   │   ├── container-manager.ts       # Orchestrates SandboxManager + ContainerService + CDP
│   │   ├── circuit-breaker.ts         # cockatiel: claude (3/60s) and github (5/120s)
│   │   ├── idempotency.ts            # Idempotency guard by branch (memory + disk)
│   │   ├── dlq.ts                     # Dead Letter Queue with exponential backoff
│   │   ├── adapter.ts                 # AdapterManager: dispatches events to outbound adapters
│   │   ├── webhook-adapter.ts         # Generic webhook with HMAC and event filter
│   │   ├── request-logger.ts          # JSONL logs per request_id + system.jsonl
│   │   └── logger.ts                  # Pino logger (pretty in dev, JSON in prod)
│   │
│   ├── validation/
│   │   └── schemas.ts                 # Zod schemas for PipelineRun and DirectorRun
│   │
│   └── config/
│       ├── schema.ts                  # Complete Zod schema with defaults
│       ├── loader.ts                  # Reads .pipeline/config.yaml + resolves ${ENV_VARS}
│       └── defaults.ts               # DEFAULT_CONFIG constant
│
├── package.json
└── tsconfig.json
```

### Component to primitive mapping

| Component             | Implementation                                                 | Description                                                                         |
| --------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| **HTTP Server**       | Hono (Bun runtime, port 3002)                                  | Receives HTTP requests from the outside world                                       |
| **Pipeline Core**     | `AgentOrchestrator` + `SDKClaudeProcess` (Claude Agent SDK)    | The Service uses the SDK directly, not CLI spawning                                 |
| **8 Agents**          | Sub-agents via Task tool (within the Claude Code process)      | The Core launches sub-agents in parallel, each executes a skill                     |
| **Sandbox**           | `SandboxManager` → Mandatory Podman container                  | Each pipeline runs inside an isolated container                                     |
| **Director**          | TypeScript class (no LLM) activated by events                  | Reads manifest, resolves dependencies, orders by priority, dispatches to Integrator |
| **Integrator**        | `AgentOrchestrator` (Claude Opus) for conflicts + git commands | 6-step saga: fetch → branch → merge → push → PR → checkout                          |
| **Event Bus**         | eventemitter3 + JSONL files                                    | In-memory distribution, on-disk persistence                                         |
| **Outbound Adapters** | `WebhookAdapter` (generic) + ingest webhook (auto-registered)  | HTTP POST with optional HMAC and event filter                                       |
| **Config**            | `.pipeline/config.yaml` (Zod validated)                        | Project configuration with `${ENV_VARS}` resolution                                 |
| **Skills**            | 8 skills installed in Claude Code                              | Each one is a specialized pipeline agent                                            |

### Project file structure

```
project/                               # User's repo
├── .pipeline/
│   ├── manifest.json                  # Branch state (ready, pending_merge, merge_history)
│   ├── config.yaml                    # Pipeline configuration for this project
│   ├── active-pipelines.json          # Idempotency guard (branch → request_id)
│   ├── events/                        # Event history (Event Bus persists here)
│   │   ├── {request_id}.jsonl         # Events from a specific pipeline
│   │   └── ...
│   ├── logs/                          # Structured JSONL logs
│   │   ├── {request_id}.jsonl         # Everything that happened in a specific pipeline
│   │   └── system.jsonl               # Director, Integrator, DLQ, infrastructure
│   ├── sagas/                         # In-progress transaction logs (Saga pattern)
│   │   └── {request_id}.json          # Steps completed per request_id
│   └── dlq/                           # Dead Letter Queue (failed events per adapter)
│       └── {adapter_name}/
│           └── {request_id}.jsonl     # Events that couldn't be delivered
│
├── CLAUDE.md                          # Director + Integrator rules
│
├── ../project-worktree-auth/          # Worktree A (externally managed)
│   └── CLAUDE.md                      # Worker rules
│
├── ../project-worktree-api/           # Worktree B (externally managed)
│   └── CLAUDE.md
│
└── ../project-worktree-ui/            # Worktree C (externally managed)
    └── CLAUDE.md
```

**Note:** The Pipeline Service is a separate application. It can run on the same machine as the worktrees or on a server. It only needs access to the worktree filesystem and to have Claude Code installed.

### Pipeline execution (what the Service does internally)

When the HTTP server receives a `POST /pipeline/run`, the Service:

```
# 1. Create pipeline branch
git checkout -b pipeline/feature/auth feature/auth

# 2. The 8 agents run in parallel as sub-agents (Task tool)
Task(security-audit)         ──┐
Task(architecture-eval)      ──┤
Task(webapp-testing)         ──┤
Task(performance)            ──┼── PARALLEL
Task(dependency-audit)       ──┤
Task(code-quality)           ──┤
Task(web-design-guidelines)  ──┤
Task(documentation-check)   ──┘

# 3. Consolidate results
# 4. If any blocking agent fails:
#    → Auto-correction on pipeline/feature/auth
#    → Commit: "fix(pipeline): description"
#    → Re-run only failed agents
#    → Repeat (max 3 attempts)
# 5. If all blocking agents pass:
#    → Emit pipeline.completed { approved: true }
#    → Manifest Writer writes to manifest.json
#    → Merge pipeline/feature/auth → feature/auth (if merge_back: true)
#    → Director detects and dispatches to Integrator
#    → Integrator creates integration/feature/auth branch based on main
#    → Integrator merges pipeline/feature/auth into integration/
#    → Integrator creates Pull Request toward main with pipeline summary
#    → Human reviews and approves the PR
# 6. If fails after 3 attempts:
#    → Emit pipeline.failed { approved: false }
#    → Outbound adapters notify
```

---

## 14. Complete Flow: Real Example

```
=== CLIENT SENDS WORKTREE TO PROCESS ===

Client: Task TASK-123 (feature/auth) ready for review

  → Client makes POST to the Pipeline Service:
    POST http://pipeline-service:3100/pipeline/run
    { branch: "feature/auth", worktree_path: "../project-auth", priority: 1,
      metadata: { task_id: "TASK-123" } }

  → Service accepts, generates PipelineRequest:
    { request_id: "abc-123", branch: "feature/auth", worktree_path: "../project-auth",
      metadata: { task_id: "TASK-123" } }

  → Core receives PipelineRequest

=== PIPELINE CORE WORKS ===

Core: "Creating branch pipeline/feature/auth from feature/auth"
  → Emits: pipeline.started { branch: "feature/auth", pipeline_branch: "pipeline/feature/auth" }
  → Client Notifier → POST to client { event: "pipeline.started", task_id: "TASK-123" }

Core: "Running 8 agents in parallel..."
  → Emits: pipeline.agents.started { agents: [...] }

  Task(security-audit)     → ❌ Token without expiration
  Task(architecture-eval)  → ✅ OK
  Task(webapp-testing)     → ✅ 25/25
  Task(performance)        → ✅ OK
  Task(dependency-audit)   → ✅ jsonwebtoken MIT, no CVEs
  Task(code-quality)       → ✅ Consistent
  Task(accessibility)      → -- Skipped (no UI)
  Task(documentation)      → ⚠️ README outdated

  → Emits: pipeline.round.completed { round: 1, blocking_failures: ["security"] }
  → Client Notifier → POST to client { progress: "7/8 passed, correcting..." }

Core: "1 blocking failure. Auto-correcting on pipeline/feature/auth..."
  → Emits: pipeline.correction.started { attempt: 1, agent: "security" }

  [Adds expiresIn: '1h' to the token]
  [Commit on pipeline/feature/auth: "fix(pipeline): add JWT token expiration"]

  → Emits: pipeline.correction.completed { attempt: 1, success: true }

Core: "Re-running security-audit..."
  Task(security-audit)     → ✅ Corrected

  → Emits: pipeline.round.completed { round: 2, blocking_failures: [] }

Core: "Pipeline APPROVED."
  → Emits: pipeline.completed { approved: true, corrections: ["security: token expiration"] }

  → Manifest Writer listens → Writes to .pipeline/manifest.json
  → Client Notifier → POST to client { status: "approved", results: {...} }
  → Slack Notifier → POST #dev "✅ feature/auth approved (1 automatic correction)"

Core: "Merge back: pipeline/feature/auth → feature/auth"
  → The corrections return to the original branch

=== CLIENT SENDS ANOTHER WORKTREE ===

Client: Task TASK-456 (feature/api) ready for review
  → POST to Pipeline Service... same flow... pipeline passes without corrections
  → Manifest Writer writes to manifest.json

=== DIRECTOR ACTIVATES ===

(Event Bus emitted pipeline.completed → Director Trigger detects it → spawn Director)

Director: "Activated. Reading manifest.json."
Director: "2 branches ready: feature/auth (P1), feature/api (P2)"
Director: "feature/ui-dashboard is not in the manifest — not touching it"
Director: "feature/ui-dashboard depends on feature/api — not yet merged"
  → Emits: director.activated { manifest_entries: 2 }

Director: "Merge queue: [auth (P1), api (P2)]"

Director: "Dispatching feature/auth to the Integrator"
  → Emits: director.integration.dispatched { branch: "feature/auth" }

=== INTEGRATION AGENT ===

Integrator: "Preparing PR for pipeline/feature/auth → main"
  → Emits: integration.started { branch: "feature/auth", integration_branch: "integration/feature/auth" }
  → git checkout -b integration/feature/auth main
  → git merge --no-ff pipeline/feature/auth
  → No conflicts
  → Post-merge pipeline: ✅ passes
  → git push origin integration/feature/auth
  → gh pr create --base main --head integration/feature/auth
    --title "Integrate: feature/auth"
    --body "## Pipeline Results\n| Tests ✅ | Security ✅ (auto-corrected) | ... |\n\n### Corrections\n- Security: token expiration"
  → Emits: integration.pr.created { branch: "feature/auth", pr_number: 42, pr_url: "https://github.com/..." }
  → Client Notifier → POST to client { task_id: "TASK-123", status: "pr_created", pr_url: "..." }

Integrator: "Preparing PR for pipeline/feature/api → main"
  → Emits: integration.started { branch: "feature/api", integration_branch: "integration/feature/api" }
  → git checkout -b integration/feature/api main
  → git merge --no-ff pipeline/feature/api
  → Conflict in routes/index.ts (both added routes)
  → Emits: integration.conflict.detected { files: ["routes/index.ts"] }
  → Resolution: combine routes from both
  → Emits: integration.conflict.resolved { resolution: "combined routes" }
  → Post-merge pipeline: ✅ passes
  → git push origin integration/feature/api
  → gh pr create --base main --head integration/feature/api
  → Emits: integration.pr.created { branch: "feature/api", pr_number: 43 }

Director: "2 PRs created. Waiting for human approval."
  → Emits: director.cycle.completed { prs_created: ["feature/auth (#42)", "feature/api (#43)"] }

=== HUMAN REVIEWS AND APPROVES PR #42 ===

(GitHub webhook arrives at Pipeline Service: PR #42 merged)
  → Emits: integration.pr.merged { branch: "feature/auth", pr_number: 42, commit_sha: "abc123" }
  → Director moves feature/auth from "pending_merge" to "merge_history"
  → Client Notifier → POST to client { task_id: "TASK-123", status: "done" }

=== CLIENT SENDS THIRD WORKTREE ===

Client: Task TASK-789 (feature/ui-dashboard) ready for review
  → POST to Pipeline Service...
  → Task(code-quality) detects isValidEmail() — validateEmail() already exists in main
  → Auto-correction: redirects to validateEmail(), removes isValidEmail()
  → Pipeline passes
  → Manifest Writer writes to manifest.json

=== DIRECTOR ACTIVATES AGAIN ===

Director: "Reading manifest.json. feature/ui-dashboard ready."
Director: "Depends on feature/api → already in merge_history ✅"
Director: "Merge queue: [ui-dashboard]"

Integrator: "Preparing PR for pipeline/feature/ui-dashboard → main"
  → git checkout -b integration/feature/ui-dashboard main
  → git merge --no-ff pipeline/feature/ui-dashboard
  → ✅ No conflicts, deduplication applied
  → Post-merge pipeline: ✅
  → git push origin integration/feature/ui-dashboard
  → gh pr create → PR #44
  → Emits: integration.pr.created { branch: "feature/ui-dashboard", pr_number: 44 }
  → Client Notifier → POST to client { task_id: "TASK-789", status: "pr_created", pr_url: "..." }

=== HUMAN REVIEWS AND APPROVES PR #44 ===

(GitHub webhook: PR #44 merged)
  → Emits: integration.pr.merged { branch: "feature/ui-dashboard", pr_number: 44 }
  → Client Notifier → POST to client { task_id: "TASK-789", status: "done" }

=== END ===

Director: "All tasks integrated into main."
  PR history:
    1. feature/auth  → PR #42 → main  (12:00)  [1 correction: security]
    2. feature/api   → PR #43 → main  (12:03)  [1 conflict resolved]
    3. feature/ui    → PR #44 → main  (12:08)  [1 deduplication]

Client:
  TASK-123 (auth)  → Done ✅  (PR #42)
  TASK-456 (api)   → Done ✅  (PR #43)
  TASK-789 (ui)    → Done ✅  (PR #44)
```

---

## 15. Design Patterns

The system uses 9 patterns. Each one solves a concrete problem in the flow.

### Pattern map

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                            PIPELINE SERVICE                                  │
│                                                                              │
│  ┌─ INBOUND ──────────┐    ┌─ CORE ───────────────┐    ┌─ OUTBOUND ──────┐  │
│  │                     │    │                       │    │                  │  │
│  │  [Adapter]          │    │  [Command]            │    │  [Adapter]       │  │
│  │  REST → Request     │───►│  PipelineRequest      │    │  Event → HTTP    │  │
│  │  CLI  → Request     │    │                       │    │  Event → Slack   │  │
│  │  MCP  → Request     │    │  [Strategy]           │    │  Event → GitHub  │  │
│  │                     │    │  Tier → agents        │    │                  │  │
│  │  [Idempotency]      │    │                       │    │  [Circuit Breaker│  │
│  │  Detect duplicates  │    │  [State Machine]      │    │   + Dead Letter] │  │
│  │  before accepting   │    │  ready → pending      │    │  If fails → DLQ  │  │
│  │                     │    │  → merge_history      │    │  If down → open  │  │
│  └─────────────────────┘    │                       │    └──────────────────┘  │
│                              │  [Saga]               │                         │
│                              │  Compensation at      │                         │
│                              │  each step            │                         │
│                              └───────────┬───────────┘                         │
│                                          │                                     │
│                                   [Observer/Pub-Sub]                           │
│                                    Event Bus                                  │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 15.1 Adapter (Hexagonal)

**Where:** Inbound adapters (REST, CLI, MCP) and Outbound adapters (Webhook, Slack, GitHub, Manifest Writer).

**What it solves:** The Core doesn't know who called it or where the results go. The adapters translate between the outside world and the internal contract (`PipelineRequest` / `PipelineEvent`).

```
Outside world          Adapter              Core
─────────────          ─────────            ─────
HTTP POST      →   REST Adapter    →   PipelineRequest
CLI args       →   CLI Adapter     →   PipelineRequest
MCP tool call  →   MCP Adapter     →   PipelineRequest

PipelineEvent  →   Webhook Adapter →   HTTP POST to client
PipelineEvent  →   Slack Adapter   →   Slack API
PipelineEvent  →   GitHub Adapter  →   gh pr comment
```

**Adding a new system** = creating an adapter. Zero changes to the Core, zero changes to other adapters.

### 15.2 Observer / Pub-Sub

**Where:** Event Bus — connects the Core with all outbound adapters.

**What it solves:** The Core emits events without knowing who listens. Adapters subscribe to the events they care about. Total decoupling.

```
Core emits:  pipeline.completed
                │
     Event Bus distributes:
                │
     ┌──────────┼──────────┬──────────────┐
     │          │          │              │
  Manifest   Webhook    Slack          GitHub
  Writer     Notifier   Notifier      Notifier
```

**Rule:** The Core never calls an adapter directly. Everything goes through the Event Bus.

### 15.3 Command

**Where:** `PipelineRequest` is a command — it encapsulates all the information needed to execute the pipeline.

**What it solves:** The request can be serialized, persisted, re-executed, and queued. The Core doesn't need to know where it came from — it just processes the command.

```json
{
  "request_id": "abc-123",
  "branch": "feature/auth",
  "worktree_path": "/path/to/worktree",
  "config": { "tier_override": "large" },
  "metadata": { "task_id": "TASK-123" }
}
```

This allows:

- **Retry:** If the pipeline fails due to a transient error, re-send the same command
- **Auditing:** Every command is recorded
- **Queue:** The Director can queue commands for the Integrator

### 15.4 Strategy

**Where:** Tier system — the Core selects which agents to execute based on the size of the change.

**What it solves:** Not all changes need all 8 agents. The strategy is automatically selected (Small/Medium/Large) or forced via `tier_override`.

```
git diff --stat → classify → select strategy
                                    │
                    ┌───────────────┼───────────────┐
                    │               │               │
                 Small           Medium           Large
                 [T, S]          [T,S,A,D,CQ]     [T,S,A,D,CQ,P,Ac,Do]
```

Each tier defines which agents run. If an agent detects a serious problem, the tier can scale up.

### 15.5 State Machine

**Where:** The manifest — lifecycle of each branch through `ready[]`, `pending_merge[]`, `merge_history[]`.

**What it solves:** At any moment you know exactly what state each branch is in. Transitions are explicit and validated.

```
(pipeline running)  →  ready  →  pending_merge  →  merge_history
        ↓                              ↓
     failed                      pr_stale → rebased → pending_merge
```

**Valid transitions:**
| From | To | Trigger |
|---|---|---|
| (running) | ready | `pipeline.completed` { approved: true } |
| (running) | (outside) | `pipeline.failed` |
| ready | pending_merge | Director dispatches, Integrator creates PR |
| pending_merge | pending_merge | Stale PR → rebase → update |
| pending_merge | ready | PR closed without merge → retry |
| pending_merge | merge_history | `integration.pr.merged` |

Invalid transitions (the system rejects them):

- ready → merge_history (cannot skip pending_merge)
- merge_history → ready (cannot go back)
- pending_merge → (outside) (an open PR doesn't disappear)

### 15.6 Saga

**Where:** The complete pipeline flow is a long-running transaction with multiple steps that can fail.

**What it solves:** Each step has a compensation action. If something fails midway, the system knows how to revert or clean up.

```
Step                              Compensation if fails
───────────────────────────────   ───────────────────────────────
1. Sandbox container (Podman)     → containerManager.cleanup(worktreePath, requestId)
   (MANDATORY: copy files,           (sandbox is required — if it fails, pipeline doesn't run)
    git clone, createSpawnFn)
2. Project containers             → stopContainers() + cdp.dispose()
   (OPTIONAL: compose up,            Failure is NON-FATAL: pipeline continues without browser tools
    health check, CDP browser)
3. Run agents                     → Emit pipeline.error, clean up sandbox + containers
   (inside sandbox via                (agent runs in /workspace inside the container)
    podman exec)
4. Auto-correction                → git reset to pre-correction commit
5. Merge back to original branch  → Keep pipeline/{branch} for debug
6. Create integration/ branch     → Delete integration/{branch} branch
7. Create PR                      → (no compensation — the PR is visible)
8. PR merged (human)              → (irreversible — compensate with revert commit)
9. Cleanup branches + containers  → Retry on next Director cycle
```

**Implementation:** The Core maintains a log of completed steps for each `request_id`. If the process is interrupted (crash, timeout), upon restart it can:

- See which step it was on
- Execute compensation for completed steps
- Or resume from where it left off

```
.pipeline/sagas/{request_id}.json
{
  "request_id": "abc-123",
  "steps_completed": ["create_branch", "run_agents", "auto_correct", "merge_back"],
  "current_step": "create_integration_branch",
  "started_at": "2026-02-14T12:00:00Z"
}
```

### 15.7 Idempotency

**Where:** Inbound adapters — before accepting a request, check if one already exists for the same branch.

**What it solves:** If a client sends the same branch twice (double click, retry, duplicate webhook), the system doesn't create two pipelines.

```
POST /pipeline/run { branch: "feature/auth" }

Inbound Adapter:
  1. Is there an active pipeline for "feature/auth"?
     → Yes: return the existing request_id (200 OK, not 202)
     → No: create new pipeline (202 Accepted)
```

```
POST /pipeline/run { branch: "feature/auth" }
→ 202 Accepted { request_id: "abc-123" }       ← first time

POST /pipeline/run { branch: "feature/auth" }
→ 200 OK { request_id: "abc-123",              ← duplicate detected
           status: "already_running",
           events_url: "/pipeline/abc-123/events" }
```

**Idempotency key:** `branch` + active state (running or pending_merge). If the branch is already in `merge_history`, a new request is valid (there may be new commits).

### 15.8 Circuit Breaker

**Where:** Outbound adapters and external dependencies (GitHub API, Claude Code).

**What it solves:** If GitHub is down, the Integrator shouldn't keep trying to create PRs indefinitely. If Claude Code fails, the Core shouldn't accumulate an infinite queue.

```
Circuit state:

CLOSED (normal)     → Calls pass through normally
  │
  │  N consecutive failures
  ▼
OPEN (tripped)      → Calls fail immediately without trying
  │                   Degradation event is emitted
  │  After timeout
  ▼
HALF-OPEN (test)    → ONE test call is allowed
  │
  ┌┴┐
  │ │
 ✅ ❌
  │ │
  ▼ ▼
CLOSED  OPEN
```

**Circuits in the system:**

| Dependency         | Consequence when OPEN                         | Recovery                       |
| ------------------ | --------------------------------------------- | ------------------------------ |
| **Claude Code**    | Pipeline requests are queued, not executed    | When closed, process queue     |
| **GitHub API**     | PRs are not created, branches stay in `ready` | Director retries on next cycle |
| **Webhook client** | Events are saved to DLQ                       | Retry when client comes back   |

```yaml
# Configuration
resilience:
  circuit_breaker:
    claude_code:
      failure_threshold: 3 # Open after 3 consecutive failures
      reset_timeout_seconds: 60 # Try again after 60s
    github_api:
      failure_threshold: 5
      reset_timeout_seconds: 120
    webhooks:
      failure_threshold: 3
      reset_timeout_seconds: 30
```

### 15.9 Dead Letter Queue (DLQ)

**Where:** Outbound adapters — when a webhook or notification fails.

**What it solves:** Events are not lost when an external adapter fails. They are saved for retry.

```
Event Bus → Webhook Adapter → POST to client
                  │
                  ├── ✅ 200 OK → event delivered
                  │
                  └── ❌ timeout / 500 / connection refused
                           │
                           ▼
                     Dead Letter Queue
                     .pipeline/dlq/{adapter}/{request_id}.jsonl
                           │
                           ▼
                     Retry with exponential backoff:
                       1st attempt: 5s
                       2nd attempt: 15s
                       3rd attempt: 45s
                       4th attempt: 135s
                       max: 5 attempts
                           │
                     ┌─────┴─────┐
                     │           │
                  ✅ Delivered  ❌ Exhausted
                     │           │
                  Remove      Emit event:
                  from DLQ    adapter.delivery.failed
                              (requires manual attention)
```

```yaml
# Configuration
resilience:
  dead_letter:
    enabled: true
    path: '.pipeline/dlq/'
    max_retries: 5
    backoff: 'exponential' # linear | exponential
    base_delay_seconds: 5
```

**Difference from event persistence:** Persistence (`.pipeline/events/*.jsonl`) is for auditing — it saves all events. The DLQ is for retries — it only saves those that failed.

---

## 16. Design Principles

1. **Autonomous Pipeline Service** — The Service runs as an independent process. Clients just make HTTP requests. They don't spawn processes, don't manage agents, don't know how it works internally.

2. **Simple clients** — Any web service only needs to make a POST and expose a webhook to receive notifications. Three new functions of code. Nothing more.

3. **Hexagonal (Ports & Adapters)** — Adapters live inside the Service. Adding a new destination (Discord, Jira, email) means adding a module to the Service. Zero changes to the Core, zero changes to clients.

4. **Event-driven** — All communication between internal components is via events. The Event Bus is the nervous system. Communication with external clients is via HTTP (webhooks or SSE).

5. **Pipeline branch** — Automatic corrections happen on `pipeline/{branch}`, protecting the developer's original branch.

6. **Opaque metadata** — The Core doesn't interpret `metadata`. It receives it, passes it in every event, and adapters use it for correlation. This keeps the Core decoupled.

7. **Worktrees are externally managed** — The pipeline doesn't create or destroy worktrees. It receives them as input. The client is responsible for managing them.

8. **The Director doesn't guess** — It doesn't scan worktrees. It reads an explicit manifest that tells it which ones are ready. It reacts to events, doesn't poll.

9. **Agents by tier** — The pipeline classifies the change (Small/Medium/Large) and runs 2, 5, or 8 agents based on impact. Tests and Security always run. The tier can scale up if an agent detects a serious problem.

10. **One agent orchestrates the pipeline** — A single agent in the Core launches the 8 sub-agents and consolidates. There are not 8 loose processes.

11. **Corrective, not just detective** — The system corrects problems automatically, not just reports them. Corrections are made on the pipeline branch.

12. **Only approved branches reach the manifest** — If the pipeline fails and can't auto-correct, the manifest is not touched. The Director never sees branches with problems.

13. **Integration via Pull Request** — The Integrator doesn't merge directly to main. It creates Pull Requests with a complete pipeline summary, providing visibility and human control. It resolves conflicts semantically and deduplicates code between branches before opening the PR.

14. **Parallel at all levels** — Multiple pipelines run in parallel. The 8 pipeline agents run in parallel. Merges are sequential (by necessity).

15. **Mandatory sandbox, optional project containers** — Each pipeline **always** runs inside a Podman sandbox container (Podman is a mandatory requirement — without it, the pipeline fails). The worktree files are copied to the container and a fresh git repo is initialized (copy + clone, not bind-mount). Additionally, if the project has `compose.yml`, project containers with CDP browser tools are started (graceful degradation if it fails). Agents receive browser tools (`cdp_navigate`, `cdp_screenshot`, `cdp_get_dom`) via MCP only when there are project containers.

16. **Post-merge pipeline** — After each merge to main, the pipeline is re-run to verify that the integration didn't break anything.

17. **Dependencies between branches** — The Director detects if a branch depends on another and doesn't merge it until its dependency is in main.

18. **Complete traceability** — Every event is persisted. The complete history of any pipeline can be reconstructed. Each correction has a dedicated commit.

19. **Extensible without modification** — New outbound adapters (Discord, Jira, email) are added as modules to the Service. Zero changes to the Core, zero changes to existing clients.

---

## Appendix A: Implementation Decisions

This appendix documents decisions made during implementation that diverge from the original design described above. The SAD describes the ideal architecture; this section describes what was implemented and why.

### A.1 Simplified agent names

**SAD (§7):** 8 agents named: `tests`, `security`, `architecture`, `performance`, `dependencies`, `code_quality`, `accessibility`, `documentation`.

**Implementation:** 8 agents with different names:

| SAD             | Implementation            | Reason                                                                      |
| --------------- | ------------------------- | --------------------------------------------------------------------------- |
| `tests`         | `tests`                   | No change                                                                   |
| `security`      | `security`                | No change                                                                   |
| `architecture`  | `architecture`            | No change                                                                   |
| `performance`   | `performance`             | No change                                                                   |
| `dependencies`  | _(absorbed into `types`)_ | Dependency verification was integrated into the types agent                 |
| `code_quality`  | `style`                   | More descriptive name for linting and code style                            |
| `accessibility` | `types`                   | Replaced by type checking (TypeScript) as more relevant in backend projects |
| `documentation` | `docs`                    | Abbreviated name                                                            |
| _(new)_         | `integration`             | Integration verification agent (only in tier Large)                         |

### A.2 Simplified agents per tier

**SAD (§7.0):** Small = `[tests, security]`, Medium = `[+architecture, +dependencies, +code_quality]`, Large = `[+performance, +accessibility, +documentation]`.

**Implementation:**

- **Small** (2): `[tests, style]` — `security` moved to Medium for being costly for trivial changes
- **Medium** (5): `[tests, security, architecture, style, types]`
- **Large** (8): `[tests, security, architecture, performance, style, types, docs, integration]`

### A.3 Auto-correction: 2 attempts instead of 3

**SAD (§10):** "Maximum 3 attempts".

**Implementation:** `max_attempts: 2` by default. Configurable via `.pipeline/config.yaml`.

**Reason:** With Claude Opus, 2 attempts are sufficient in practice. If the agent can't correct in 2 attempts, the problem likely requires human intervention. Reduces cost and execution time.

### A.4 Post-merge pipeline not implemented

**SAD (§9, §15.6):** "Re-run pipeline on the merge result to verify integrity" — after the Integrator merges `pipeline/{branch}` into `integration/{branch}`, the full pipeline is re-run on the result.

**Implementation:** The Integrator **does not** re-run the pipeline post-merge. After the merge (with or without resolved conflicts), it proceeds directly to push + create PR.

**Reason:** Re-running the full pipeline doubles the cost and time of each integration. Integrity verification is delegated to the repository's CI/CD (GitHub Actions, etc.) that runs on the PR. If needed in the future, it can be added as an optional step in the Integrator's saga.

### A.5 Simplified configuration

**SAD (§12):** Granular configuration with per-agent `enabled`/`blocking`/`tier`/`condition` flags, multiple Event Bus backends (`local`/`redis`/`nats`), integration modes (`pull-request`/`auto-merge`), and detailed inbound/outbound adapter configuration.

**Implementation (Zod schema):** Simplified configuration in 11 sections:

| SAD                                                   | Implementation                                 | Note                                                                                      |
| ----------------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Per-agent `enabled`/`blocking` flags                  | Tier-based agent arrays (`tiers.small.agents`) | Simpler; agents are enabled/disabled by tier                                              |
| `event_bus.implementation: redis/nats`                | Only EventEmitter (in-memory + JSONL)          | Sufficient for single-machine; Redis/NATS would be added if multi-machine is needed       |
| `integration.mode: pull-request/auto-merge`           | Only `pull-request`                            | The final merge to main always requires human approval                                    |
| `adapters.inbound` (REST, CLI, MCP, webhook)          | Only REST API (Hono)                           | CLI and MCP are added via integration with `@funny/server`                                |
| `adapters.outbound` (manifest, client, slack, github) | Generic `adapters.webhooks[]`                  | A single adapter type (webhook) covers all cases; specific adapters are added as demanded |
| `logging.per_request`, `.sources`, `.retention_days`  | Only `logging.level`                           | Pino logger with configurable level; persistence is via EventBus JSONL                    |

### A.6 Technology stack

**SAD (§13):** "Node.js application (Express/Fastify)" with Claude Code processes spawned as subprocesses (`claude -p "..."`).

**Implementation:**

- **Runtime:** Bun (not Node.js) — faster, fewer dependencies
- **HTTP Framework:** Hono (not Express/Fastify) — lighter, edge-ready
- **Agent SDK:** `@funny/core/agents` which uses `AgentOrchestrator` + `SDKClaudeProcess` (Claude Agent SDK, not CLI subprocess)
- **Git operations:** `@funny/core/git` which uses `execute()` via `Bun.spawn` (not `execa` or `child_process`)
- **Port:** `3002` (not `3100` as stated in the SAD) — to avoid conflicts with the main server on `3001`
- **Monorepo package:** `@funny/agent` within the `funny` workspace

### A.7 Saga: 7 steps instead of 9

**SAD (§15.6):** 9 saga steps with compensations (including post-merge pipeline and branch cleanup).

**Implementation of the Integrator Saga:** 6 operational steps + 1 restore step:

| #   | Step                        | Compensation                          |
| --- | --------------------------- | ------------------------------------- |
| 1   | `fetch_main`                | _(none — idempotent)_                 |
| 2   | `create_integration_branch` | `git branch -D` + `git checkout main` |
| 3   | `merge_pipeline`            | `git merge --abort`                   |
| 4   | `push_branch`               | `git push origin --delete`            |
| 5   | `create_pr`                 | _(none — the PR is visible)_          |
| 6   | `checkout_main`             | _(none)_                              |

**Differences:**

- No "Create pipeline/{branch} branch" — the branch already exists when it reaches the Integrator
- No "Post-merge pipeline" — we don't re-run the pipeline (see §A.4)
- No "Branch cleanup" — cleanup is a separate process via `BranchCleaner`, not part of the saga

### A.8 Branch cleanup as a separate component

**SAD (§9):** "The Director executes cleanup as part of its cycle".

**Implementation:** `BranchCleaner` is an independent component that reacts to events via the EventBus:

- `pipeline.completed` → deletes `pipeline/{branch}`
- `pipeline.failed` → keeps or deletes based on `cleanup.keep_on_failure` config
- `integration.pr.merged` → deletes `pipeline/` + `integration/` (pending: requires GitHub webhook)

**Reason:** Separating cleanup from the Director keeps each component with a single responsibility. The Director coordinates integrations; the BranchCleaner cleans up branches.

### A.9 Events: actual catalog vs SAD

**SAD (§3.2):** Events like `pipeline.branch.created`, `pipeline.agents.started`, `pipeline.round.completed`, `pipeline.correction.started`, `integration.pipeline.running`.

**Implementation:** Simplified catalog with consistent names:

```
Pipeline: accepted, started, containers.ready, tier_classified, agent.started,
          agent.completed, agent.failed, correcting, completed, failed, stopped, message
Director: activated, integration.dispatched, integration.pr_created,
          pr.rebase_needed, cycle.completed
Integration: started, conflict.detected, conflict.resolved, pr.created,
             pr.rebased, pr.rebase_failed, completed, failed
Cleanup: started, completed
```

Events **new** in the implementation (not in the original SAD):

- `pipeline.containers.ready` — emitted when Step 0 completes: containers started, health check OK, CDP browser ready

Events from the SAD that **don't exist** in the implementation:

- `pipeline.branch.created` — the branch is created implicitly
- `pipeline.agents.started` — each agent emits its own `agent.started`
- `pipeline.round.completed` — there's no concept of "rounds" (a single agent orchestrates)
- `pipeline.correction.started/completed` — `pipeline.correcting` is emitted without per-agent granularity
- `integration.pipeline.running` — we don't re-run the pipeline post-merge

### A.10 Container Infrastructure: Mandatory Sandbox + Browser Tools

**SAD (original):** Didn't exist — agents only did static analysis without access to the running application.

**Implementation:** A **Step 0 for infrastructure** was added to the `PipelineRunner` with **two layers**:

**Layer 1 — Sandbox (MANDATORY):**

1. Verifies that Podman is installed (if not → error with installation instructions)
2. Builds the `funny-sandbox` image if it doesn't exist (lazy, once)
3. Creates a `pipeline-sandbox-{requestId}` container with the worktree mounted **read-only** at `/mnt/source`
4. Copies files (excluding `.git`) from the mount to `/workspace`
5. Initializes a fresh git repo: `git init` → `git remote add origin` → `git fetch --depth=50` → `git checkout`
6. Creates a `spawnClaudeCodeProcess` that redirects the Claude Code process inside the container via `podman exec`

**Layer 2 — Project (OPTIONAL):** 7. Detects if the worktree has a `compose.yml` (or variants) 8. If it exists: starts containers via Podman (`podman compose up -d`), waits for health checks 9. Creates an MCP server with Playwright headless Chrome (tools: `cdp_navigate`, `cdp_screenshot`, `cdp_get_dom`) 10. Injects the MCP server and `spawnClaudeCodeProcess` into `orchestrator.startAgent()`

**Package architecture:**

- `@funny/core/containers` — Reusable library (`SandboxManager`, `ContainerService`, `createCdpMcpServer`)
- `@funny/agent/infrastructure/container-manager.ts` — Pipeline-specific orchestration

**Copy + Clone Strategy (why not bind-mount):**

- Git worktrees use a `.git` pointer file (not a directory), and bind-mounting this doesn't work correctly inside a Linux container
- Cross-platform: the host can be Windows, the container is Linux — paths are not compatible
- Permissions: bind-mounts inherit host permissions, causing issues with the container's `sandbox` user
- Solution: copy files + `git init` + `git fetch --depth=50` inside the container

**Reason:** Agents run in an isolated and reproducible environment. Additionally, when there are project containers, they can interact with the running application for E2E tests, visual verification, accessibility (WCAG), and performance.

**Degradation:** The sandbox is **mandatory** — without Podman the pipeline doesn't run. Project containers are **optional** — if their setup fails (compose doesn't exist, health timeout, Playwright fails), the pipeline continues with the sandbox but without browser tools.

### A.11 `pipeline.cli_message` events for UI rendering

**SAD (original):** Pipeline events are only lifecycle events (started, completed, failed, etc.).

**Implementation:** The `PipelineRunner` emits **two event streams** in parallel:

1. **`pipeline.cli_message`** — Each raw `CLIMessage` from the agent is forwarded as an event. Contains the complete message JSON (tool calls, bash output, assistant text, etc.). These events reach the main UI via the ingest webhook (see §A.12) and are rendered exactly like messages from a normal thread.

2. **Lifecycle events** — The typed events (`pipeline.started`, `pipeline.completed`, etc.) generated by the `PipelineEventMapper`. Used internally for the Manifest Writer, idempotency release, Director auto-trigger, branch cleanup, and container cleanup.

```
CLIMessage from agent
         │
         ├──→ pipeline.cli_message (ALWAYS) → EventBus → Ingest Webhook → UI
         │
         └──→ PipelineEventMapper.map() (CONDITIONAL) → Lifecycle event
```

**Reason:** The UI needs to show the complete agent output (tool cards, bash output, etc.) exactly as it appears in a normal thread. Lifecycle events are too abstract to render a detailed view.

### A.12 Ingest webhook for event forwarding to the UI

**SAD (original):** Outbound adapters are manually configured in `.pipeline/config.yaml`.

**Implementation:** An internal webhook adapter is automatically registered that forwards **all** pipeline events to the `/api/ingest/webhook` endpoint of the main server (`@funny/server`). This allows pipeline events (including `pipeline.cli_message`) to appear in the funny UI.

```
EventBus
   │
   ├── Webhook Adapters (configured by user)
   │
   └── Ingest Webhook (auto-registered)
       → POST {INGEST_WEBHOOK_URL}/api/ingest/webhook
       → Default: http://localhost:3001/api/ingest/webhook
```

**Environment variables:**

- `INGEST_WEBHOOK_URL` — Full URL of the ingest endpoint (default: `http://localhost:{SERVER_PORT}/api/ingest/webhook`)
- `INGEST_WEBHOOK_SECRET` — Shared secret for HMAC authentication (optional)
- `SERVER_PORT` — Main server port as fallback for building the URL (default: `3001`)

**Reason:** Without this webhook, the pipeline runs as an isolated service and its events don't appear in the UI. Auto-registration ensures the integration works out-of-the-box without extra configuration.

### A.13 Additional events not documented in the original SAD

The implementation added several events that weren't in the original catalog:

| Event                                   | When emitted                                                | Note                                                             |
| --------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------- |
| `pipeline.accepted`                     | When receiving the PipelineRequest, before classifying tier | Allows the UI to immediately show that the pipeline was accepted |
| `pipeline.tier_classified`              | After classifying the tier                                  | Reports tier and diff stats                                      |
| `pipeline.stopped`                      | When a pipeline is stopped manually (POST /:id/stop)        | Different from `failed` — it was stopped intentionally           |
| `pipeline.cli_message`                  | With each CLIMessage from the agent                         | See §A.11                                                        |
| `pipeline.message`                      | Free-form text from the pipeline                            | Generic type for informational messages                          |
| `cleanup.started` / `cleanup.completed` | When starting/finishing branch cleanup                      | Emitted by BranchCleaner                                         |
