# @funny/agent — Autonomous Issue-to-PR Pipeline

An autonomous agent service that takes issues from your GitHub backlog and processes them all the way to merged PRs. It plans implementations, spawns coding agents in isolated worktrees, runs quality checks, creates PRs, handles CI failures, routes review feedback, and only pings you when human judgment is needed.

Think of it as an AI project manager: it reads your backlog, decomposes features, assigns tasks to coding agents, monitors their progress, and self-heals when things break.

## Prerequisites

- [Bun](https://bun.sh/) >= 1.2
- Git
- [`gh` CLI](https://cli.github.com/) authenticated (`gh auth login`) for GitHub issue tracking
- `api-acp` running on port 4010 (agent API — `/v1/runs` protocol)
- [Hatchet](https://hatchet.run/) (optional — enables durable workflows and batch processing)

## Quick Start

```bash
# From the monorepo root
bun install

# Start the agent service (port 3002, hot reload)
cd packages/agent
bun run dev

# Start a session for a single issue
curl -X POST http://localhost:3002/sessions/start \
  -H "Content-Type: application/json" \
  -d '{"issueNumber": 42, "projectPath": "/path/to/your/repo"}'

# Process multiple issues from backlog (requires Hatchet)
curl -X POST http://localhost:3002/sessions/batch \
  -H "Content-Type: application/json" \
  -d '{"projectPath": "/path/to/your/repo", "labels": ["agent-ready"]}'
```

## How It Works

### The Session Lifecycle

Every issue gets a **Session** that tracks its full lifecycle:

```
created → planning → implementing → quality_check → pr_created →
ci_running → ci_passed → review → merged
                ↓                      ↓
           ci_failed              changes_requested
                ↓                      ↓
         (auto-retry)           (auto-apply feedback)
                ↓          Pero me refiero específicamente a este error en el proceso de la gente.             ↓
           escalated               escalated
```

### The Flow

1. **Fetch issue** — Pull full issue details + comments from GitHub
2. **Plan** — Orchestrator agent reads the issue + explores the codebase → produces an implementation plan (which files, approach, risks)
3. **Create workspace** — Isolated git worktree on `issue/N` branch
4. **Implement** — Coding agent executes the plan (up to 200 turns)
5. **Quality check** — Parallel quality agents (tests, security, architecture, style, types)
6. **Create PR** — Push branch, create PR with `Closes #N`
7. **Wait for CI** — Durable wait; if CI fails, Watchdog auto-respawns agent to fix
8. **Wait for review** — Durable wait; if changes requested, agent auto-applies feedback
9. **Merge & close** — Squash merge, close issue, cleanup worktree

### Reactions (Self-Healing)

The **Watchdog** listens for events and takes automatic action:

| Event               | Default Action  | Behavior                                                       |
| ------------------- | --------------- | -------------------------------------------------------------- |
| CI failed           | `respawn_agent` | Agent reads failure logs, fixes code, pushes (up to 3 retries) |
| Changes requested   | `respawn_agent` | Agent reads review comments, applies fixes (up to 2 retries)   |
| Approved + CI green | `notify`        | Sends notification (or `auto_merge` if configured)             |
| Agent stuck         | `escalate`      | Escalates after 15 min of inactivity                           |

All reactions are config-driven — no hardcoded behavior.

## Running

### Development

```bash
# From this directory
bun run dev          # watch mode (auto-restarts)

# Or from the monorepo root
bun run dev          # starts both server + agent
```

### Production

```bash
bun src/server.ts
```

### Environment Variables

| Variable                | Default                                    | Description                                   |
| ----------------------- | ------------------------------------------ | --------------------------------------------- |
| `PORT`                  | `3002`                                     | HTTP server port                              |
| `PROJECT_PATH`          | `process.cwd()`                            | Root of the git repo to operate on            |
| `HATCHET_CLIENT_TOKEN`  | —                                          | Hatchet API token (enables durable workflows) |
| `INGEST_WEBHOOK_URL`    | `http://localhost:3001/api/ingest/webhook` | Where to forward events for UI visibility     |
| `INGEST_WEBHOOK_SECRET` | —                                          | Shared secret for webhook authentication      |

Bun reads `.env` automatically — no `dotenv` needed.

## Configuration

The service reads `.pipeline/config.yaml` from the project root. If the file doesn't exist, all defaults are used. Environment variables in `${VAR_NAME}` format are resolved before validation.

### Full Example

```yaml
# ── Issue Tracker ──────────────────────────────────────────────
tracker:
  type: github # github | linear (linear coming soon)
  repo: owner/repo # auto-detected from git remote if not set
  labels: [agent-ready] # only pick issues with this label
  exclude_labels: [wontfix, blocked]
  max_parallel: 5 # max concurrent sessions

# ── Orchestrator Agent ─────────────────────────────────────────
orchestrator:
  model: claude-sonnet-4-5-20250929
  provider: funny-api-acp
  auto_decompose: true # split complex issues into sub-tasks
  plan_approval: false # require human approval before implementing
  max_planning_turns: 30
  max_implementing_turns: 200

# ── Sessions ───────────────────────────────────────────────────
sessions:
  max_retries_ci: 3 # CI fix attempts before escalating
  max_retries_review: 2 # review feedback cycles before escalating
  escalate_after_min: 30 # escalate stuck sessions after N minutes
  auto_merge: false # auto-merge when approved + CI green

# ── Reactions ──────────────────────────────────────────────────
reactions:
  ci_failed:
    action: respawn_agent # respawn_agent | notify | escalate
    prompt: 'CI failed on this PR. Read the failure logs and fix the issues.'
    max_retries: 3
  changes_requested:
    action: respawn_agent
    prompt: 'Review comments have been posted. Address each comment.'
    max_retries: 2
    escalate_after_min: 30
  approved_and_green:
    action: notify # notify | auto_merge
    message: 'PR approved and CI green — ready to merge'
  agent_stuck:
    action: escalate
    after_min: 15
    message: 'Session stuck — needs human review'

# ── Quality Pipeline (existing) ────────────────────────────────
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
  pipeline_prefix: 'pipeline/'
  integration_prefix: 'integration/'
  main: main

auto_correction:
  max_attempts: 2

director:
  schedule_interval_ms: 0 # 0 = disabled
  auto_trigger_delay_ms: 500

cleanup:
  keep_on_failure: false
  stale_branch_days: 7

adapters:
  webhooks:
    - url: https://example.com/webhook
      secret: '${WEBHOOK_SECRET}'
      events: [pipeline.completed, pipeline.failed]

logging:
  level: info
```

## API Endpoints

The server runs on `http://localhost:3002` by default. The primary entrypoint is `/sessions` — this is how you trigger autonomous issue processing. Quality checks and merge orchestration happen internally via direct function calls (no separate HTTP endpoints).

### Health

| Method | Path      | Description                |
| ------ | --------- | -------------------------- |
| GET    | `/health` | Returns `{ status: "ok" }` |

### Sessions — Primary API

These are the endpoints you'll use to process issues autonomously. Each session takes an issue from your backlog and drives it to a merged PR.

| Method | Path                     | Description                                             |
| ------ | ------------------------ | ------------------------------------------------------- |
| GET    | `/sessions`              | List all sessions (filter with `?status=implementing`)  |
| GET    | `/sessions/:id`          | Session detail with full event log                      |
| POST   | `/sessions/start`        | Start a session for a single issue                      |
| POST   | `/sessions/batch`        | Process multiple issues from backlog (requires Hatchet) |
| POST   | `/sessions/:id/escalate` | Manually escalate a stuck session                       |
| POST   | `/sessions/:id/cancel`   | Cancel a session                                        |
| DELETE | `/sessions/:id`          | Remove a session record                                 |

#### POST /sessions/start

Starts the full issue-to-PR pipeline for a single issue. The orchestrator agent will plan, implement, create a PR, and handle CI/review cycles.

```json
{
  "issueNumber": 42,
  "projectPath": "/path/to/repo",
  "model": "claude-sonnet-4-5-20250929",
  "provider": "funny-api-acp",
  "baseBranch": "main"
}
```

#### POST /sessions/batch

Scans the backlog, prioritizes issues, and spawns parallel sessions (up to `maxParallel`). Requires Hatchet for durable orchestration.

```json
{
  "projectPath": "/path/to/repo",
  "issueNumbers": [42, 58, 61],
  "labels": ["agent-ready"],
  "maxParallel": 3
}
```

#### GET /sessions/:id — Response

```json
{
  "id": "session-abc123",
  "status": "implementing",
  "issue": { "number": 42, "title": "Add dark mode", "url": "..." },
  "plan": { "summary": "...", "files_to_modify": [...], "estimated_complexity": "medium" },
  "branch": "issue/42",
  "worktreePath": "/repo/.funny-worktrees/issue-42",
  "prNumber": null,
  "ciAttempts": 0,
  "reviewAttempts": 0,
  "events": [...]
}
```

### Webhooks

Configure GitHub webhooks to point here for automatic CI/review reactions on sessions.

| Method | Path               | Description                   |
| ------ | ------------------ | ----------------------------- |
| POST   | `/webhooks/github` | Receive GitHub webhook events |

Supported GitHub events:

- **`check_suite`** (success/failure) — Triggers session reactions (auto-fix CI failures)
- **`pull_request_review`** (changes_requested) — Triggers session reactions (auto-apply review feedback)
- **`pull_request_review`** (approved) — Advances session to merged (or notifies for manual merge)
- **`pull_request`** (merged) — Triggers branch cleanup

### Logs

| Method | Path                 | Description                          |
| ------ | -------------------- | ------------------------------------ |
| GET    | `/logs/pipeline/:id` | Logs for a specific pipeline request |
| GET    | `/logs/system`       | System-level logs                    |
| GET    | `/logs/requests`     | List all request IDs with logs       |

## GitHub Webhook Setup

To enable automatic CI/review reactions, configure a webhook on your repo:

1. Go to **Settings > Webhooks > Add webhook**
2. **Payload URL:** `http://<your-host>:3002/webhooks/github`
3. **Content type:** `application/json`
4. **Secret:** (optional, set `webhook_secret` in config to match)
5. **Events:** Select `Check suites`, `Pull requests`, `Pull request reviews`

## Hatchet Workflows

When Hatchet is configured (`HATCHET_CLIENT_TOKEN`), the service registers durable workflows that survive server restarts:

### issue-to-pr (triggered via `POST /sessions/start`)

The core workflow. When you call `POST /sessions/start`, this is what runs under the hood:

1. **fetch-issue** — Pull full issue details + comments from GitHub
2. **plan-issue** — Orchestrator agent explores codebase, creates implementation plan
3. **create-workspace** — Isolated git worktree on `issue/N` branch
4. **implement** — Coding agent executes the plan (up to 200 turns)
5. **quality-check** — Runs the quality pipeline directly via `PipelineRunner`
6. **create-pr** — Push branch, create PR with `Closes #N`
7. **wait-for-ci** — Durable wait for CI result (reactions handle failures automatically)
8. **wait-for-review** — Durable wait for review (reactions handle feedback automatically)
9. **merge-and-close** — Squash merge, close issue, cleanup worktree

### backlog-processor (triggered via `POST /sessions/batch`)

When you call `POST /sessions/batch`, this workflow scans the issue backlog, prioritizes by labels/age, and spawns parallel `issue-to-pr` workflows (up to `max_parallel`).

### feature-to-deploy

Alternative flow for text prompts (not issues): classify complexity → create worktree → implement → quality pipeline (direct `PipelineRunner` call) → wait for approval → deploy.

### pr-review-loop (triggered automatically via webhooks)

Fires when GitHub sends a `pull_request_review` webhook with `changes_requested`. Fetches review comments, runs an agent to apply feedback, pushes updates, checks approval status.

### cleanup

Removes stale pipeline/integration branches and orphaned worktrees older than the configured threshold.

### doc-gardening

Scans for stale documentation, generates update suggestions.

## Architecture

```
src/
├── server.ts                      # Bun server bootstrap
├── index.ts                       # App wiring: config, singletons, event listeners, routes
├── config/
│   ├── schema.ts                  # Zod config schema (tiers, tracker, reactions, sessions, etc.)
│   ├── loader.ts                  # YAML loader with env var resolution
│   └── defaults.ts                # Default config values
├── core/
│   ├── session.ts                 # Session class with lifecycle state machine (14 states)
│   ├── session-store.ts           # In-memory + file-persisted session CRUD
│   ├── orchestrator-agent.ts      # LLM agent for issue planning + implementation
│   ├── watchdog.ts                # Declarative event-driven watchdog
│   ├── pipeline-runner.ts         # Quality pipeline orchestration
│   ├── quality-pipeline.ts        # Parallel quality agents with correction cycles
│   ├── director.ts                # Merge queue management
│   ├── integrator.ts              # PR creation, conflict resolution, rebasing
│   ├── manifest-manager.ts        # Branch lifecycle tracking
│   ├── agent-roles.ts             # Agent role definitions (tests, security, style, etc.)
│   ├── branch-cleaner.ts          # Stale branch cleanup
│   ├── saga.ts                    # Saga pattern with compensation
│   ├── state-machine.ts           # Generic FSM for pipelines + branches
│   ├── tier-classifier.ts         # Change size classification
│   └── types.ts                   # Domain types + event types
├── trackers/
│   ├── tracker.ts                 # Pluggable issue tracker interface
│   └── github-tracker.ts          # GitHub Issues via `gh` CLI
├── hatchet/
│   ├── client.ts                  # Hatchet SDK singleton
│   ├── worker.ts                  # Worker registration (all 6 workflows)
│   └── workflows/
│       ├── issue-to-pr.ts         # Issue → Plan → Implement → PR → CI → Review → Merge
│       ├── backlog-processor.ts   # Scan backlog → prioritize → spawn sessions
│       ├── feature-to-deploy.ts   # Prompt → Implement → Quality → PR → Deploy
│       ├── pr-review-loop.ts      # Fetch reviews → apply feedback → push
│       ├── cleanup.ts             # Remove stale branches/worktrees
│       └── doc-gardening.ts       # Documentation maintenance
├── infrastructure/
│   ├── event-bus.ts               # eventemitter3 pub/sub + JSONL persistence
│   ├── circuit-breaker.ts         # cockatiel circuit breakers (Claude + GitHub)
│   ├── idempotency.ts             # Duplicate pipeline prevention
│   ├── dlq.ts                     # File-based dead letter queue
│   ├── adapter.ts                 # Outbound adapter manager
│   ├── webhook-adapter.ts         # HTTP webhook delivery
│   ├── request-logger.ts          # Per-request JSONL logging
│   └── logger.ts                  # Pino structured logging
├── routes/
│   ├── sessions.ts                # /sessions/* endpoints (start, batch, escalate, cancel)
│   ├── webhooks.ts                # /webhooks/github (PR, review, CI events)
│   └── logs.ts                    # /logs/* endpoints
└── validation/
    └── schemas.ts                 # Zod request/response schemas
```

### Key Design Decisions

1. **Sessions are first-class** — Every issue gets a Session with a 14-state lifecycle machine and full audit trail
2. **Reactions are declarative** — Config-driven policies, not hardcoded logic. Swap between `respawn_agent`, `escalate`, and `notify` per event type
3. **Orchestrator is an agent** — Uses LLM to understand issues + codebase and produce real implementation plans
4. **Plugin architecture** — Tracker interface is pluggable (GitHub first, Linear planned). Agent providers are swappable via config
5. **Builds on existing infra** — EventBus, circuit breakers, DLQ, Integrator, Director all reused from the quality pipeline
6. **Works with and without Hatchet** — Single-issue sessions work inline; batch processing and durable waits need Hatchet

## Testing

```bash
bun test
```

## Bruno API Collection

The `bruno/` directory contains a [Bruno](https://www.usebruno.com/) collection with pre-built requests for all endpoints.

## Further Reading

- [SAD.md](SAD.md) — Full architecture document
- [TECH-STACK.md](TECH-STACK.md) — Technology choices
