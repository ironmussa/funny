# @funny/agent — Pipeline Service

An autonomous pipeline service that runs quality-assurance agents (security, testing, architecture, etc.) against git branches in parallel using the Claude Agent SDK. It classifies changes by tier, auto-corrects failures, and integrates approved branches via PR.

## Prerequisites

- [Bun](https://bun.sh/) >= 1.2
- Git
- Claude Code CLI (for the agent SDK)

## Running

### Development

```bash
# From the monorepo root — install all workspace dependencies
npm install

# Start with watch mode (auto-restarts on file changes)
# From the monorepo root:
npm run dev

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

### Director

| Method | Path | Description |
|---|---|---|
| POST | `/director/run` | Trigger a director cycle manually |
| GET | `/director/status` | Director status + merge queue |
| GET | `/director/manifest` | Raw manifest (for debugging) |

### Webhooks

| Method | Path | Description |
|---|---|---|
| POST | `/webhooks/github` | Receive GitHub `pull_request` webhook events |

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
├── server.ts              # Bun server bootstrap
├── index.ts               # App wiring: config, singletons, event listeners, Hono routes
├── config/
│   ├── schema.ts          # Zod config schema
│   ├── loader.ts          # YAML loader with env var resolution
│   └── defaults.ts        # Default config values
├── core/
│   ├── pipeline-runner.ts # Spawns Claude Code agents via the SDK
│   ├── director.ts        # Reads manifest, decides what to integrate
│   ├── integrator.ts      # Creates PRs, resolves conflicts, rebases
│   ├── manifest-manager.ts# Reads/writes .pipeline/manifest.json
│   ├── tier-classifier.ts # Classifies changes as small/medium/large
│   ├── branch-cleaner.ts  # Cleans up pipeline/integration branches
│   ├── prompt-builder.ts  # Builds prompts for the pipeline agent
│   ├── saga.ts            # Saga pattern with compensation
│   └── state-machine.ts   # Branch lifecycle state machine
├── infrastructure/
│   ├── event-bus.ts       # eventemitter3 pub/sub + JSONL persistence
│   ├── circuit-breaker.ts # cockatiel circuit breakers (Claude + GitHub)
│   ├── idempotency.ts     # Prevents duplicate pipeline runs per branch
│   ├── dlq.ts             # File-based dead letter queue
│   ├── adapter.ts         # Outbound adapter manager
│   ├── webhook-adapter.ts # HTTP webhook delivery
│   ├── container-manager.ts # Podman container lifecycle
│   ├── request-logger.ts  # Per-request JSONL logging
│   └── logger.ts          # Pino logger setup
├── routes/
│   ├── pipeline.ts        # /pipeline/* endpoints
│   ├── director.ts        # /director/* endpoints
│   ├── webhooks.ts        # /webhooks/github endpoint
│   └── logs.ts            # /logs/* endpoints
└── validation/
    └── schemas.ts         # Zod request/response schemas
```
