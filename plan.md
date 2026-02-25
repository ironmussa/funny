# Plan: Wire `packages/agent` into the main server

## Problem

The agent package (Watchdog, sessions, webhooks, OrchestratorAgent) is fully implemented but runs as a standalone Hono server on port 3002. Nobody starts it. The IngestWebhookAdapter sends events over HTTP to the main server — unnecessary overhead when both live in the same monorepo. We need to embed the agent service directly into the main server.

## Key Constraint

`packages/agent/src/index.ts` has side effects at import time — it loads config from disk, creates singletons, auto-starts the Watchdog and IngestWebhookAdapter. We can't just `import { app }` and mount it. We need a factory pattern.

## Approach: Factory + Lazy Per-Project Initialization

The agent service is **per-project** (config lives in `.pipeline/config.yaml` at the project root). The main server manages multiple projects. So we create agent service instances lazily, one per project, on demand.

## Steps

### Step 1: Refactor `packages/agent/src/index.ts` — export factory instead of singletons

**What changes:**
- Extract all initialization logic into `createAgentService(opts)` async factory function
- Factory receives `projectPath`, optional `onEvent` callback (to emit directly to ingest-mapper instead of HTTP)
- Factory returns `{ app, eventBus, sessionStore, orchestratorAgent, watchdog, tracker, start(), stop() }`
- `start()` activates the Watchdog + event forwarding. `stop()` cleans up.
- Keep the old `server.ts` working by calling the factory there (backward compat for standalone mode)

**Files:** `packages/agent/src/index.ts`, `packages/agent/src/server.ts`

### Step 2: Replace `IngestWebhookAdapter` with direct callback

**What changes:**
- Instead of HTTP POST to `localhost:3001/api/ingest/webhook`, the factory accepts an `onEvent` callback
- When embedded, the main server passes `(event) => handleIngestEvent(event)` directly — zero network overhead
- When standalone (server.ts), the HTTP adapter is still used as fallback

**Files:** `packages/agent/src/index.ts`

### Step 3: Create `packages/server/src/services/agent-service.ts` — manages per-project agent instances

**What changes:**
- New file: `agent-service.ts`
- `getAgentService(projectId)` — lazy initializer, creates and caches agent service for a project
- `stopAgentService(projectId)` — cleanup
- `stopAllAgentServices()` — shutdown hook
- Registers with `shutdownManager` for graceful cleanup

**Files:** new `packages/server/src/services/agent-service.ts`

### Step 4: Mount agent routes in the main server

**What changes:**
- Add `/api/agent/:projectId/sessions/*` and `/api/agent/:projectId/webhooks/*` routes
- Route handler resolves the project, gets/creates the agent service, forwards the request to the agent's Hono app
- GitHub webhooks route: `/api/agent/webhooks/github` (project-agnostic, resolved from branch name)

**Files:** new `packages/server/src/routes/agent.ts`, `packages/server/src/index.ts`

### Step 5: Add client API functions + session start from UI

**What changes:**
- Add `api.startSession(projectId, input)` in `packages/client/src/lib/api.ts`
- Wire "Start Session" action in the project context menu (where "Run Pipeline" used to be)
- Sessions appear as threads via the existing ingest-mapper pipeline (no new UI components needed yet)

**Files:** `packages/client/src/lib/api.ts`, `packages/client/src/components/sidebar/ProjectItem.tsx`

## What we're NOT doing in this PR

- No new UI views for sessions (they appear as regular threads via ingest-mapper)
- No attention zones / health grouping (separate task)
- No batch processing (separate task)
- No config UI for `.pipeline/config.yaml` (edit YAML manually for now)

## Architecture After

```
User clicks "Start Session" on project ->
  POST /api/agent/:projectId/sessions/start { issueNumber, prompt } ->
  agent-service.ts lazily creates AgentService for project ->
  OrchestratorAgent plans + implements issue ->
  Events flow via direct callback to ingest-mapper ->
  ingest-mapper creates thread + streams messages/tool calls ->
  UI shows thread in sidebar with live streaming ->
  Watchdog monitors for CI failures / review comments ->
  GitHub webhook -> POST /api/agent/webhooks/github -> Watchdog reacts
```
