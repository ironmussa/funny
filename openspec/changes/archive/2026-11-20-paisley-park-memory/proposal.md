## Why

Funny agents start every thread with zero project context. When a user opens a new thread to implement a feature, debug, or review code, the agent has no knowledge of past decisions, known bugs, established conventions, or the team's working patterns. Users repeatedly explain the same context across threads. A transversal memory system ("Paisley Park") gives agents automatic, relevant project knowledge at thread start — the agent arrives already knowing what the project knows.

## What Changes

- New memory storage system at `~/.funny/memory/{project-id}/` — git-backed filesystem where each memory fact is a markdown file with full frontmatter metadata (type, confidence, temporal validity, decay class, relationships)
- Bi-temporal tracking engine — every fact tracks when it was true (`valid_from`/`invalid_at`) and when it was learned (`ingested_at`), with automatic conflict detection and supersession
- Retrieval engine combining embedding search, keyword/BM25 search, and graph traversal of related facts, with temporal filtering and decay-based ranking
- TypeScript API: `recall()`, `add()`, `invalidate()`, `evolve()`, `search()`, `timeline()`
- MCP Server exposing `pp_recall`, `pp_add`, `pp_invalidate`, `pp_search` tools via stdio transport for external agent integration
- Automatic recall injection into agent `systemPrefix` when a thread starts — formatted markdown sections (Decisions, Known Issues, Patterns) injected before the agent's first response
- Garbage collection agent for decay sweep, deduplication, consolidation, orphan cleanup, and index rebuild
- Operator profiles (multi-user mode) — per-operator preferences, expertise, and ownership areas consulted during recall
- Team knowledge directory — roster, module ownership, and norms readable by agents

## Capabilities

### New Capabilities

- `memory-storage`: Git-backed filesystem storage layer for memory facts with full frontmatter metadata, directory structure, and git commit tracking
- `memory-temporal`: Bi-temporal tracking, conflict detection, supersession linking, and decay scoring engine
- `memory-retrieval`: Multi-strategy retrieval (embeddings, BM25, graph traversal) with ranking, temporal filtering, and deduplication
- `memory-api`: TypeScript API (recall, add, invalidate, evolve, search, timeline) and MCP Server tools
- `memory-recall-injection`: Automatic recall at thread start with formatted context injection into agent systemPrefix
- `memory-gc`: Garbage collection agent for archiving, dedup, consolidation, orphan cleanup, and index rebuild
- `memory-operators`: Operator profiles and team knowledge directories for multi-user context

### Modified Capabilities

_(none — no existing specs are affected)_

## Impact

- **New package or service directory**: `packages/runtime/src/services/memory/` — core Paisley Park implementation
- **Agent runner**: `packages/runtime/src/services/agent-runner.ts` — systemPrefix injection point modified to include memory recall
- **Thread context builder**: `packages/runtime/src/services/thread-context-builder.ts` — extended with memory recall step
- **Shared types**: `packages/shared/src/types.ts` — new MemoryFact, RecallOptions, SearchFilters, and related interfaces
- **New routes**: `/api/memory/*` — REST endpoints for manual memory inspection/management
- **New MCP server entry point**: Separate process for external tool access
- **New dependencies**: `gray-matter` (frontmatter parsing), `sqlite-vec` or HNSW library (vector index), `@modelcontextprotocol/sdk` (MCP server)
- **Filesystem**: Creates `~/.funny/memory/` directory tree with per-project git repos
