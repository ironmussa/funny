# @funny/agent — Pipeline & Workflow Service

An autonomous pipeline service that orchestrates quality-assurance agents, durable workflows, and PR review loops using the Vercel AI SDK (multi-provider) and Hatchet. It classifies changes by tier, runs quality checks, auto-corrects failures, handles PR review feedback, and integrates approved branches.

## Prerequisites

- [Bun](https://bun.sh/) >= 1.2
- Git
- [Hatchet](https://hatchet.run/) (optional — enables durable workflows)

## Running

### Development

```bash
# From the monorepo root — install all workspace dependencies
bun install

# Start with watch mode (auto-restarts on file changes)
# From the monorepo root:
bun run dev

# Or from this directory:
bun --watch src/server.ts
```

### Production

```bash
bun src/server.ts
```

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3002` | HTTP server port |
| `PROJECT_PATH` | `process.cwd()` | Root of the git repo to operate on |
| `HATCHET_CLIENT_TOKEN` | — | Hatchet API token (enables durable workflows) |

Bun reads `.env` automatically — no `dotenv` needed.

## Configuration

The service reads `.pipeline/config.yaml` from the project root. If the file doesn't exist, all defaults are used. Environment variables in `${VAR_NAME}` format are resolved before validation.

Example `.pipeline/config.yaml`:

```yaml
tiers:
  small:
    max_files: 3
    max_lines: 50
    agents: [tests, style]
  medium:
    max_files: 10
    max_lines: 300
    agents: [tests, security, architecture, style, types]

branch:
  pipeline_prefix: "pipeline/"
  integration_prefix: "integration/"
  main: main

agents:
  pipeline:
    model: sonnet
    maxTurns: 200
  conflict:
    model: opus
    maxTurns: 50

auto_correction:
  max_attempts: 2

director:
  schedule_interval_ms: 0        # 0 = disabled, e.g. 300000 for every 5 min
  auto_trigger_delay_ms: 500

cleanup:
  keep_on_failure: false
  stale_branch_days: 7

adapters:
  webhooks:
    - url: https://example.com/webhook
      secret: "${WEBHOOK_SECRET}"
      events: [pipeline.completed, pipeline.failed]

logging:
  level: info
```

## Hatchet Workflows

When Hatchet is configured (`HATCHET_CLIENT_TOKEN`), the service registers durable workflows that orchestrate multi-step pipelines with retry, timeout, and DAG-based task dependencies.

### feature-to-deploy

Full feature lifecycle: classify complexity, create worktree, implement feature via agent, run quality pipeline, wait for pipeline results, wait for PR approval, then deploy.

### doc-gardening

Scans the codebase for stale or missing documentation, generates updates, and opens a PR.

### cleanup

Removes stale pipeline/integration branches and orphaned worktrees older than the configured threshold.

### pr-review-loop

Triggered by GitHub `pull_request_review` webhooks when changes are requested. Fetches review comments, runs an agent to apply feedback, pushes updates, and checks if the PR is now approved. Each review cycle triggers a new workflow run (event-driven, not a loop within a single run).

**Flow:**
1. `fetch-reviews` — Fetches latest review comments via `gh` CLI
2. `apply-feedback` — AgentExecutor reads reviews, edits code, commits
3. `push-and-check` — Pushes to origin, checks approval status, emits `pr.approved` if approved

## API Endpoints

The server runs on `http://localhost:3002` by default.

### Health

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Returns `{ status: "ok" }` |

### Pipeline

| Method | Path | Description |
|---|---|---|
| POST | `/pipeline/run` | Start a pipeline run (returns `202 Accepted`) |
| GET | `/pipeline/:id` | Get pipeline state |
| GET | `/pipeline/:id/events` | SSE stream of pipeline events |
| POST | `/pipeline/workflow` | Trigger a Hatchet workflow by name |
| GET | `/pipeline/workflow/:runId` | Get workflow run status from Hatchet |
| GET | `/pipeline/list` | List all pipeline runs |

### Director

| Method | Path | Description |
|---|---|---|
| POST | `/director/run` | Trigger a director cycle manually |
| GET | `/director/status` | Director status + merge queue |
| GET | `/director/manifest` | Raw manifest (for debugging) |

### Webhooks

| Method | Path | Description |
|---|---|---|
| POST | `/webhooks/github` | Receive GitHub webhook events (`pull_request`, `pull_request_review`) |

Supported GitHub events:
- **`pull_request`** (action=closed, merged=true) — Emits `integration.pr.merged` when an integration branch PR is merged
- **`pull_request_review`** (action=submitted, state=changes_requested) — Triggers `pr-review-loop` workflow
- **`pull_request_review`** (action=submitted, state=approved) — Emits `pr.approved` event to unblock `wait-for-approval` durable tasks

### Logs

| Method | Path | Description |
|---|---|---|
| GET | `/logs/pipeline/:id` | Logs for a specific pipeline request |
| GET | `/logs/system` | System-level logs (Director, Integrator, DLQ) |
| GET | `/logs/requests` | List all request IDs with logs |

## Testing

```bash
bun test
```

## Bruno API Collection

The `bruno/` directory contains a [Bruno](https://www.usebruno.com/) collection with pre-built requests for all endpoints. Open it in Bruno to explore and test the API interactively.

## Architecture

See [SAD.md](SAD.md) for the full architecture document and [TECH-STACK.md](TECH-STACK.md) for detailed technology choices.

### Key components

```
src/
├── server.ts                # Bun server bootstrap
├── index.ts                 # App wiring: config, singletons, event listeners, Hono routes
├── config/
│   ├── schema.ts            # Zod config schema
│   ├── loader.ts            # YAML loader with env var resolution
│   └── defaults.ts          # Default config values
├── core/
│   ├── pipeline-runner.ts   # Spawns Claude Code agents via the SDK
│   ├── quality-pipeline.ts  # Orchestrates quality checks with correction cycles
│   ├── director.ts          # Reads manifest, decides what to integrate
│   ├── integrator.ts        # Creates PRs, resolves conflicts, rebases
│   ├── manifest-manager.ts  # Reads/writes .pipeline/manifest.json
│   ├── manifest-types.ts    # Manifest lifecycle types
│   ├── tier-classifier.ts   # Classifies changes as small/medium/large
│   ├── branch-cleaner.ts    # Cleans up pipeline/integration branches
│   ├── agent-roles.ts       # Agent role definitions for AgentExecutor
│   ├── saga.ts              # Saga pattern with compensation
│   ├── state-machine.ts     # Branch lifecycle state machine
│   └── types.ts             # Domain types (PipelineEventType, AgentName, etc.)
├── hatchet/
│   ├── client.ts            # Hatchet SDK singleton
│   ├── worker.ts            # Worker registration (all workflows)
│   └── workflows/
│       ├── feature-to-deploy.ts  # Full feature lifecycle workflow
│       ├── doc-gardening.ts      # Documentation maintenance workflow
│       ├── cleanup.ts            # Branch/worktree cleanup workflow
│       └── pr-review-loop.ts     # PR review feedback loop workflow
├── infrastructure/
│   ├── event-bus.ts         # eventemitter3 pub/sub + JSONL persistence
│   ├── circuit-breaker.ts   # cockatiel circuit breakers (Claude + GitHub)
│   ├── idempotency.ts       # Prevents duplicate pipeline runs per branch
│   ├── dlq.ts               # File-based dead letter queue
│   ├── adapter.ts           # Outbound adapter manager
│   ├── webhook-adapter.ts   # HTTP webhook delivery
│   ├── container-manager.ts # Podman container lifecycle
│   ├── request-logger.ts    # Per-request JSONL logging
│   └── logger.ts            # Pino logger setup
├── routes/
│   ├── pipeline.ts          # /pipeline/* endpoints (run, status, workflow trigger)
│   ├── director.ts          # /director/* endpoints
│   ├── webhooks.ts          # /webhooks/github (PR merged + PR review events)
│   └── logs.ts              # /logs/* endpoints
└── validation/
    └── schemas.ts           # Zod request/response schemas
```
