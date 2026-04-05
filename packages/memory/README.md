# Paisley Park

Standalone project memory system for AI agent teams. Stores knowledge as **facts** in a libSQL database, syncs across instances via embedded replicas, and uses an LLM-powered consolidation agent to keep memory clean and concise.

Runs as an independent process — no dependency on any specific agent framework or runtime.

## Overview

```
┌─────────────────────────────────────────────────────┐
│  Paisley Park (standalone process)                   │
│                                                      │
│  ┌──────────┐  ┌───────────┐  ┌──────────────────┐ │
│  │ REST API │  │ MCP Server│  │ Consolidation    │ │
│  │ :4020    │  │ (stdio)   │  │ Agent            │ │
│  └────┬─────┘  └─────┬─────┘  └──────┬───────────┘ │
│       │               │               │             │
│  ┌────┴───────────────┴───────────────┴──────────┐  │
│  │            PaisleyPark (core)                  │  │
│  │  recall · add · invalidate · evolve            │  │
│  │  search · timeline · consolidate               │  │
│  └───────────────────┬───────────────────────────┘  │
│                      │                               │
│  ┌───────────────────┴───────────────────────────┐  │
│  │           libSQL (@libsql/client)             │  │
│  │   file:local.db  ·  libsql://remote           │  │
│  └───────────────────────────────────────────────┘  │
└──────────────────────┬──────────────────────────────┘
                       │ HTTP (consolidation only)
                       ▼
              ┌────────────────┐
              │   api-acp      │
              │  /v1/runs      │
              │  (any LLM)     │
              └────────────────┘
```

## Installation Guide

### Prerequisites

- [Bun](https://bun.sh) v1.1+ installed
- (Optional) [Ollama](https://ollama.com) for semantic search embeddings — without it, search falls back to keyword-only

If you want semantic search, pull the embedding model:

```bash
ollama pull nomic-embed-text
```

---

### Mode 1: Local (single developer, no server needed)

This is the simplest setup. Memory is stored in a local SQLite file. No external services required.

**Step 1 — Choose where to store the database**

Pick a path for the SQLite file. It can live anywhere:

```bash
# Inside your project (add to .gitignore)
PP_DB_URL=file:./memory.db

# Or in a shared location
PP_DB_URL=file:~/.funny/memory/my-project.db
```

**Step 2a — Start as MCP server (for Claude Code / Cursor)**

Add to your project's `.mcp.json` at the repo root:

```json
{
  "mcpServers": {
    "paisley-park": {
      "command": "bun",
      "args": ["packages/memory/src/mcp/server.ts"],
      "env": {
        "PP_PROJECT_ID": "my-project",
        "PP_PROJECT_NAME": "My Project",
        "PP_DB_URL": "file:memory.db"
      }
    }
  }
}
```

Restart Claude Code. Run `/mcp` to verify the server is connected. The tools `pp_recall`, `pp_add`, `pp_invalidate`, and `pp_search` are now available.

**Step 2b — Or start as REST API server**

```bash
PP_DB_URL=file:memory.db \
PP_PROJECT_ID=my-project \
PP_PROJECT_NAME="My Project" \
bun packages/memory/src/server.ts
```

The API runs on port 4020. Test it:

```bash
# Add a fact
curl -X POST localhost:4020/v1/facts \
  -H 'Content-Type: application/json' \
  -d '{"content": "API uses rate limiting at 100 req/min", "type": "convention"}'

# Recall
curl -X POST localhost:4020/v1/recall \
  -H 'Content-Type: application/json' \
  -d '{"query": "rate limiting"}'
```

**Step 2c — Or use as a library**

```typescript
import { PaisleyPark } from '@funny/memory';

const memory = new PaisleyPark({
  url: 'file:memory.db',
  projectId: 'my-project',
  projectName: 'My Project',
});

await memory.add('We chose PostgreSQL for analytics because of JSONB support', {
  type: 'decision',
  tags: ['database', 'analytics'],
});

const result = await memory.recall('database choice for analytics');
console.log(result.formattedContext);
```

That's it. No Turso, no server, no tokens. The database file is created automatically on first use.

---

### Mode 2: Team with Turso (managed cloud)

Use this when multiple developers need to share project memory. [Turso](https://turso.tech) hosts the central database; each developer keeps a local replica that syncs automatically.

```
Developer 1 ──► local replica ──┐
Developer 2 ──► local replica ──┼──► Turso (cloud)
Developer 3 ──► local replica ──┘
```

**Step 1 — Install the Turso CLI**

```bash
# macOS / Linux
curl -sSfL https://get.tur.so/install.sh | bash

# Verify
turso --version
```

**Step 2 — Sign up and authenticate**

```bash
turso auth signup   # First time only
turso auth login    # Or log in if you already have an account
```

**Step 3 — Create a database**

```bash
turso db create paisley-memory

# Choose a region close to your team (optional)
turso db create paisley-memory --location gru  # Sao Paulo
turso db create paisley-memory --location iad  # Virginia
```

**Step 4 — Get the connection URL and auth token**

```bash
# Get the URL
turso db show paisley-memory --url
# Output: libsql://paisley-memory-youruser.turso.io

# Create an auth token
turso db tokens create paisley-memory
# Output: eyJhbGciOi...
```

Save both values. Share them securely with your team (e.g. via a password manager or `.env` file that is **not** committed to git).

**Step 5 — Configure each developer's machine**

Each developer adds this to their project's `.mcp.json`:

```json
{
  "mcpServers": {
    "paisley-park": {
      "command": "bun",
      "args": ["packages/memory/src/mcp/server.ts"],
      "env": {
        "PP_PROJECT_ID": "my-project",
        "PP_PROJECT_NAME": "My Project",
        "PP_DB_URL": "file:local-replica.db",
        "PP_SYNC_URL": "libsql://paisley-memory-youruser.turso.io",
        "PP_AUTH_TOKEN": "eyJhbGciOi..."
      }
    }
  }
}
```

Or as environment variables for the REST API / library:

```bash
export PP_DB_URL=file:local-replica.db
export PP_SYNC_URL=libsql://paisley-memory-youruser.turso.io
export PP_AUTH_TOKEN=eyJhbGciOi...
export PP_PROJECT_ID=my-project
export PP_PROJECT_NAME="My Project"
```

**How it works:** reads are instant (from the local replica file). Writes go to Turso and sync back to all replicas automatically. If a developer is offline, reads still work from the local copy; writes will sync when connectivity is restored.

**Turso free tier** includes 500 databases, 9 GB storage, and 25 million row reads/month — more than enough for project memory.

---

### Mode 3: Team with self-hosted sqld

Use this if you want full control and don't want to depend on Turso's cloud. You run your own [sqld](https://github.com/tursodatabase/libsql/tree/main/libsql-server) server.

```
Developer 1 ──► local replica ──┐
Developer 2 ──► local replica ──┼──► sqld (your server)
Developer 3 ──► local replica ──┘
```

**Step 1 — Install sqld on your server**

```bash
# Option A: Docker
docker run -d \
  --name sqld \
  -p 8080:8080 \
  -v sqld-data:/var/lib/sqld \
  ghcr.io/tursodatabase/libsql-server:latest

# Option B: Build from source
cargo install libsql-server
sqld --http-listen-addr 0.0.0.0:8080 --db-path /var/lib/sqld/memory.db
```

**Step 2 — (Optional) Set up authentication**

For production, generate an auth token and start sqld with it:

```bash
# Generate a random token
openssl rand -hex 32
# Output: a1b2c3d4...

# Start sqld with auth
sqld --http-listen-addr 0.0.0.0:8080 \
     --auth-jwt-key-file /path/to/jwt-key \
     --db-path /var/lib/sqld/memory.db
```

**Step 3 — Configure each developer's machine**

```json
{
  "mcpServers": {
    "paisley-park": {
      "command": "bun",
      "args": ["packages/memory/src/mcp/server.ts"],
      "env": {
        "PP_PROJECT_ID": "my-project",
        "PP_PROJECT_NAME": "My Project",
        "PP_DB_URL": "file:local-replica.db",
        "PP_SYNC_URL": "libsql://your-server.com:8080",
        "PP_AUTH_TOKEN": "a1b2c3d4..."
      }
    }
  }
}
```

---

### Sync modes summary

| Config | Behavior | Use case |
|--------|----------|----------|
| `PP_DB_URL=file:memory.db` | Local only — single SQLite file, no sync | Solo developer |
| `PP_DB_URL=libsql://host` | Direct remote — all I/O goes to the server | Low-latency server nearby |
| `PP_DB_URL=file:replica.db` + `PP_SYNC_URL` | Embedded replica — local reads, remote writes, auto-sync | Team (recommended) |

### Consolidation

Any instance can trigger consolidation, but **only one runs at a time** via a distributed lock in the database. The first instance to acquire the lock after the trigger threshold (10 completions or 6 hours) performs the consolidation. Others skip.

```
Dev 1 finishes thread #10 → acquires lock → consolidates → releases lock
Dev 2 finishes thread #11 → lock taken → skips
Dev 3 (2 hours later)     → recall() → sees consolidated facts
```

No dedicated daemon needed. No extra infrastructure.

## Consolidation agent

The consolidation agent is an LLM-powered process that keeps memory clean. It runs inside Paisley Park and calls an external LLM via [api-acp](../api-acp/) (or any OpenAI-compatible endpoint).

### What it does

1. **Cluster consolidation** — Finds groups of similar facts (cosine ≥ 0.8) and asks the LLM to merge them into one concise fact
2. **Staleness detection** — Identifies facts that may conflict with current state and flags them for review
3. **Admission filtering** — Rejects facts that contain derivable information (code structure, git history, file paths)
4. **Date normalization** — Converts relative dates ("last Thursday") to absolute ("2026-04-01")

### How it connects to the LLM

Paisley Park does NOT embed any LLM SDK. It makes plain HTTP calls to an api-acp server:

```
PaisleyPark                            api-acp
    │                                     │
    ├── POST /v1/runs ───────────────────►│
    │   { model: "claude-haiku",          │
    │     prompt: "consolidate these...", │
    │     system_prompt: "...",           │──► Claude/GPT/Ollama
    │     max_turns: 1 }                  │
    │                                     │
    │◄── { result: { text: "..." } } ─────┤
    │                                     │
```

Configure it via the `llm` option:

```typescript
const memory = new PaisleyPark({
  url: 'file:memory.db',
  projectId: 'my-project',
  projectName: 'My Project',
  // Optional — without this, only mechanical GC runs (decay + dedup)
  llm: {
    baseUrl: 'http://localhost:4010',  // api-acp URL
    model: 'claude-haiku',             // cheap model for maintenance tasks
    apiKey: 'optional-key',
  },
});
```

If `llm` is not provided, consolidation is disabled and only mechanical GC runs (decay sweep, dedup by embedding similarity, orphan cleanup).

## REST API

Paisley Park runs as a standalone HTTP server on port 4020 (configurable via `PP_PORT`).

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check |
| `POST` | `/v1/recall` | Recall relevant facts for a query |
| `POST` | `/v1/facts` | Add a new fact |
| `GET` | `/v1/facts` | List facts (with filters) |
| `PATCH` | `/v1/facts/:id/invalidate` | Mark a fact as invalid |
| `PATCH` | `/v1/facts/:id/evolve` | Evolve a fact with new information |
| `POST` | `/v1/search` | Search with filters |
| `GET` | `/v1/timeline` | Chronological fact view |
| `POST` | `/v1/consolidate` | Trigger consolidation manually |
| `POST` | `/v1/gc` | Trigger garbage collection manually |

### Example: recall

```bash
curl -X POST localhost:4020/v1/recall \
  -H 'Content-Type: application/json' \
  -d '{"query": "authentication", "limit": 5}'
```

```json
{
  "facts": [...],
  "formattedContext": "[PROJECT MEMORY]\n...\n[/PROJECT MEMORY]",
  "totalFound": 3
}
```

## MCP Server

For direct integration with Claude Code, Cursor, or any MCP-aware agent.

### Tools

| Tool | Description |
|------|-------------|
| `pp_recall` | Retrieve relevant project memories for a query |
| `pp_add` | Add a new fact to project memory |
| `pp_invalidate` | Mark a fact as no longer valid |
| `pp_search` | Search memories with type/tag/date filters |

### Environment Variables

| Variable | Description |
|----------|-------------|
| `PP_PROJECT_ID` | Project identifier (default: `default`) |
| `PP_PROJECT_NAME` | Project display name (default: `default`) |
| `PP_DB_URL` | libSQL connection URL (default: `file:memory.db`) |
| `PP_SYNC_URL` | Sync URL for embedded replicas |
| `PP_AUTH_TOKEN` | Auth token for remote connections |
| `PP_LLM_URL` | api-acp base URL (enables consolidation) |
| `PP_LLM_MODEL` | Model for consolidation (default: `claude-haiku`) |

## Architecture

### Storage (`storage.ts`)

Single libSQL database with three tables:

```sql
facts              -- All fact data (content, metadata, timestamps)
fact_embeddings    -- Vector embeddings for semantic search
meta               -- Key-value store (index metadata, consolidation lock)
```

Schema is auto-created on first connection. Works with local SQLite, remote sqld, and embedded replicas.

### Fact types and decay

| Type | Decay class | Lambda | Half-life | Description |
|------|-------------|--------|-----------|-------------|
| `decision` | slow | 0.003 | ~231 days | Architectural/design decisions |
| `bug` | normal | 0.015 | ~46 days | Known issues, debugging notes |
| `pattern` | slow | 0.003 | ~231 days | Recurring code/architecture patterns |
| `convention` | slow | 0.003 | ~231 days | Project standards and rules |
| `insight` | normal | 0.015 | ~46 days | Non-obvious observations |
| `context` | fast | 0.05 | ~14 days | Ephemeral context (sprints, freezes) |

Decay formula: `score = exp(-λ × days_since_last_access)`

### Retrieval engine (`retrieval.ts`)

Four-stage pipeline:

1. **Embedding search** (weight 0.7) — Cosine similarity over stored embeddings
2. **Keyword search** (weight 0.3) — Term matching against content and tags
3. **Graph traversal** — BFS up to 2 hops from top results via relationship graph
4. **Ranking** — Filters by validity/confidence, applies temporal decay (±40% score adjustment)

### Embedding providers (`embedding.ts`)

| Provider | Model | Dimensions | Config |
|----------|-------|------------|--------|
| Ollama (default) | `nomic-embed-text` | 768 | Auto-detected on `localhost:11434` |
| OpenAI | `text-embedding-3-small` | 1536 | `MEMORY_EMBEDDING_PROVIDER=openai` + `OPENAI_API_KEY` |
| Null (fallback) | — | 0 | Keyword-only search when no provider available |

### Consolidation agent (`consolidator.ts`)

LLM-powered memory maintenance. Calls api-acp for intelligent tasks:

1. **Cluster consolidation** — Groups similar facts, asks LLM to merge into one
2. **Admission filter** — Rejects derivable information before storage
3. **Date normalization** — Converts relative → absolute dates

Uses a distributed lock in the `meta` table to ensure only one instance consolidates at a time (5-minute TTL, auto-expires on crash).

### Temporal engine (`temporal.ts`)

- **Bi-temporal queries** — `wasValidAt(fact, date)` for point-in-time lookups
- **Decay scoring** — Exponential decay based on last access time
- **Conflict detection** — Embedding similarity classifies new facts as `duplicate` (≥0.98), `contradicts` (≥0.92), or `extends` (≥0.85)
- **Access tracking** — Batched in-memory tracker, flushes after 5 accesses or 5 minutes

### Garbage collector (`gc.ts`)

Mechanical maintenance (no LLM required):

1. **Decay sweep** — Invalidates facts below decay threshold (default 0.1)
2. **Orphan cleanup** — Invalidates fast-decay facts with no access in 90 days
3. **Semantic dedup** — Merges near-duplicate facts (cosine ≥ 0.95)
4. **Index verification** — Rebuilds vector index if count discrepancy exceeds 20%

### Formatter (`formatter.ts`)

Converts recalled facts into markdown for system prompt injection. Output is wrapped in `[PROJECT MEMORY]` tags with a skepticism disclaimer — retrieved memories are hints, not ground truth. Groups by type, includes age and confidence annotations, enforces ~8000 character budget (~2000 tokens).

### What NOT to store

Paisley Park rejects facts containing derivable information:

- File/directory structure (read the filesystem)
- Git history, blame, PR details (run `git log`)
- Function signatures, class definitions (read the code)
- Test/build results (run the tests)
- Debugging session logs (ephemeral by nature)

If it can be derived by running a command or reading a file, it doesn't belong in memory.

## Library API

### `PaisleyPark` class

```typescript
import { PaisleyPark } from '@funny/memory';

const pp = new PaisleyPark(config);
// init() is called automatically by all methods

// Core operations
await pp.recall(query, { limit?, scope?, minConfidence?, asOf?, forOperator? });
await pp.add(content, { type, tags?, confidence?, sourceAgent?, sourceOperator? });
await pp.invalidate(factId, reason?);
await pp.evolve(factId, updateText);
await pp.search(query, { type?, tags?, validAt?, createdAfter?, createdBefore? });
await pp.timeline({ from?, to?, type?, includeInvalidated? });

// Maintenance
await pp.consolidate();  // LLM-powered consolidation (requires llm config)

// Cleanup
await pp.destroy();
```

### Configuration

```typescript
interface StorageConfig {
  /** libSQL URL — file:path (local) or libsql://host (remote) */
  url: string;
  /** Sync URL for embedded replicas */
  syncUrl?: string;
  /** Auth token for remote connections */
  authToken?: string;
  /** Sync interval in seconds (default: 60) */
  syncInterval?: number;
  /** Project ID */
  projectId: string;
  /** Project display name */
  projectName: string;
  /** LLM config for consolidation agent (optional) */
  llm?: {
    /** api-acp base URL (e.g. http://localhost:4010) */
    baseUrl: string;
    /** Model ID (default: claude-haiku) */
    model?: string;
    /** Optional API key */
    apiKey?: string;
  };
}
```

### Factory function

```typescript
import { getPaisleyPark } from '@funny/memory';

// Singleton per projectId
const pp = getPaisleyPark({
  url: 'file:memory.db',
  projectId: 'my-project',
  projectName: 'My Project',
});
```

### GC functions

```typescript
import { runGC, shouldRunGC, trackThreadCompletion, markGCComplete } from '@funny/memory';

trackThreadCompletion();

if (shouldRunGC()) {
  await runGC(config);
  markGCComplete();
}
```

## Dependencies

| Package | Purpose |
|---------|---------|
| `@libsql/client` | Database (local SQLite + remote sync) |
| `hono` | REST API server |
| `@modelcontextprotocol/sdk` | MCP server transport |
| `neverthrow` | Result type for error handling |
| `zod` | Schema validation |

No LLM SDK dependencies. Consolidation uses plain HTTP calls to api-acp.
