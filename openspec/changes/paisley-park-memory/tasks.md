## 1. Shared Types & Dependencies

- [x] 1.1 Add `MemoryFact`, `RecallOptions`, `SearchFilters`, `AddOptions`, `TimelineOptions`, `FactType`, `DecayClass`, `Scope` types to `packages/shared/src/types.ts`
- [x] 1.2 Install `gray-matter` dependency in `packages/runtime`
- [x] 1.3 Install `sqlite-vec` dependency in `packages/runtime` (or compatible SQLite vector extension for Bun)
- [x] 1.4 Install `@modelcontextprotocol/sdk` dependency in `packages/runtime`

## 2. Storage Layer

- [x] 2.1 Create `packages/runtime/src/services/memory/types.ts` — internal types (MemoryFactFile, StorageConfig, WriteLock interface)
- [x] 2.2 Create `packages/runtime/src/services/memory/storage.ts` — git-backed filesystem: initMemoryDir(), readFact(), writeFact(), moveFact(), listFacts(), gitCommit(), acquireLock(), releaseLock()
- [x] 2.3 Implement memory directory initialization with git repo creation, subdirectory scaffolding (project/facts/, project/archive/, operators/, team/, sessions/), and initial commit
- [x] 2.4 Implement fact file read/write with gray-matter frontmatter parsing (all 16 fields)
- [x] 2.5 Implement write lock (file-based mutex) for concurrent git operation safety
- [x] 2.6 Implement INDEX.md auto-generation — group active facts by type, sorted by recency, regenerate after each write
- [x] 2.7 Implement `.gitignore` for `.index/` directory in memory repo
- [x] 2.8 Create initial template files: `project/CONVENTIONS.md`, `team/ROSTER.md`, `team/ownership.md`, `team/norms.md`

## 3. Temporal Engine

- [x] 3.1 Create `packages/runtime/src/services/memory/temporal.ts` — bi-temporal tracking, conflict detection, decay calculation
- [x] 3.2 Implement decay score calculation: `exp(-λ * days_since_last_access)` with λ per decay_class (slow=0.003, normal=0.015, fast=0.05)
- [x] 3.3 Implement decay_class auto-inference from fact type (decision→slow, bug→normal, pattern→slow, convention→slow, insight→normal, context→fast)
- [x] 3.4 Implement fact invalidation logic — update frontmatter (invalid_at, invalidated_by, superseded_by), append Invalidation section to content
- [x] 3.5 Implement fact evolution logic — update content and ingested_at, reject if fact is invalidated
- [x] 3.6 Implement conflict detection: embedding similarity check (threshold 0.85) → heuristic classification (contradicts/extends/duplicate/unrelated) → auto-link related facts
- [x] 3.7 Implement access tracking with batched writes — accumulate access_count/last_accessed updates in memory, flush to disk every 5 facts or 5 minutes

## 4. Embedding Provider

- [x] 4.1 Create `packages/runtime/src/services/memory/embedding.ts` — EmbeddingProvider interface with embed(), embedBatch(), dimensions()
- [x] 4.2 Implement OllamaEmbeddingProvider — calls local Ollama API for embeddings (default model: nomic-embed-text)
- [x] 4.3 Implement OpenAIEmbeddingProvider — calls OpenAI API for text-embedding-3-small
- [x] 4.4 Implement provider factory — select provider based on MEMORY_EMBEDDING_PROVIDER env var, graceful fallback to null provider when unavailable

## 5. Vector Index

- [x] 5.1 Create `packages/runtime/src/services/memory/vector-index.ts` — SQLite-vec wrapper for vector storage and search
- [x] 5.2 Implement vector index initialization — create .index/vectors.db with vec_facts virtual table, .index/meta.json with model config
- [x] 5.3 Implement addVector(), removeVector(), searchSimilar(query, topK) operations
- [x] 5.4 Implement model change detection — compare meta.json model ID with current config, trigger full re-index if different
- [x] 5.5 Implement full index rebuild from filesystem — scan all fact files, embed, insert into vector table

## 6. Relationship Graph

- [x] 6.1 Create `packages/runtime/src/services/memory/graph.ts` — in-memory adjacency map (Map<string, Set<string>>)
- [x] 6.2 Implement graph build from filesystem — parse all fact frontmatter, extract related[] fields, build bidirectional adjacency map
- [x] 6.3 Implement graph traversal — BFS from seed fact IDs, return related facts up to N hops (default 2)
- [x] 6.4 Implement graph updates — addEdge(), removeEdge() for real-time graph maintenance on fact create/invalidate

## 7. Retrieval Engine

- [x] 7.1 Create `packages/runtime/src/services/memory/retrieval.ts` — orchestrates embedding search, keyword search, graph traversal, and ranking
- [x] 7.2 Implement keyword/BM25 search — search fact content and tags for query terms, score by term frequency
- [x] 7.3 Implement combined search — run embedding + keyword in parallel, merge results with weighted scoring
- [x] 7.4 Implement ranking engine — temporal filter (exclude invalidated), decay scoring, relevance weighting, deduplication, limit enforcement
- [x] 7.5 Implement scope filtering — filter results by scope (project, operator, team, all)

## 8. PaisleyPark Core API

- [x] 8.1 Create `packages/runtime/src/services/memory/index.ts` — PaisleyPark class with lazy initialization
- [x] 8.2 Implement recall(query, options?) — orchestrate retrieval engine, format results, update access tracking
- [x] 8.3 Implement add(content, options) — create fact file, run conflict detection, update indexes, update graph, regenerate INDEX.md, git commit
- [x] 8.4 Implement invalidate(factId, reason?) — update frontmatter, regenerate INDEX.md, update indexes, git commit
- [x] 8.5 Implement evolve(factId, update) — update content, re-embed, git commit
- [x] 8.6 Implement search(query, filters?) — filtered retrieval without graph traversal or auto-formatting
- [x] 8.7 Implement timeline(options?) — chronological query with date range and type filters, include invalidated by default

## 9. Recall Formatter

- [x] 9.1 Create `packages/runtime/src/services/memory/formatter.ts` — format recall results as injectable markdown
- [x] 9.2 Implement fact-to-markdown formatting — group by type (Decisions, Known Issues, Patterns, Conventions, Insights, Context), each fact as bullet with content/confidence/age
- [x] 9.3 Implement operator section formatting — parse PROFILE.md, format as "Current Operator" section with preferences
- [x] 9.4 Implement token limit enforcement — truncate lowest-scored facts until output is under 2000 tokens
- [x] 9.5 Wrap formatted output in `[PROJECT MEMORY]` / `[/PROJECT MEMORY]` tags

## 10. Agent Runner Integration

- [x] 10.1 Add memory recall call in `agent-runner.ts` startAgent() — call recallForThread() before systemPrefix composition
- [x] 10.2 Modify systemPrefix composition to include memory context between project instructions and resume prefix
- [x] 10.3 Pass operator info (username from auth context) to recall when in multi-user mode
- [x] 10.4 Handle recall errors gracefully — if memory recall fails, log warning and proceed without memory context

## 11. REST API Routes

- [x] 11.1 Create `packages/runtime/src/routes/memory.ts` — Hono route group for memory operations
- [x] 11.2 Implement GET `/api/projects/:projectId/memory/recall` — query param: query, limit, scope, minConfidence
- [x] 11.3 Implement POST `/api/projects/:projectId/memory/facts` — body: content, type, tags, confidence, relatedTo
- [x] 11.4 Implement PATCH `/api/projects/:projectId/memory/facts/:factId/invalidate` — body: reason
- [x] 11.5 Implement PATCH `/api/projects/:projectId/memory/facts/:factId/evolve` — body: update
- [x] 11.6 Implement GET `/api/projects/:projectId/memory/search` — query params: query, type, tags, validAt, minConfidence
- [x] 11.7 Implement GET `/api/projects/:projectId/memory/timeline` — query params: from, to, type
- [x] 11.8 Implement POST `/api/projects/:projectId/memory/gc` — trigger manual GC run
- [x] 11.9 Mount memory routes in `packages/runtime/src/index.ts` under `/api/projects/:projectId/memory`

## 12. MCP Server

- [x] 12.1 Create `packages/runtime/src/services/memory/mcp/server.ts` — MCP server entry point with stdio transport
- [x] 12.2 Implement pp_recall tool — maps to recall() with query, limit, scope params
- [x] 12.3 Implement pp_add tool — maps to add() with content, type, tags params
- [x] 12.4 Implement pp_invalidate tool — maps to invalidate() with factId, reason params
- [x] 12.5 Implement pp_search tool — maps to search() with query, type, tags, validAt params
- [x] 12.6 Add MCP server start script to package.json

## 13. Garbage Collection Agent

- [x] 13.1 Create `packages/runtime/src/services/memory/gc.ts` — GC agent orchestrator
- [x] 13.2 Implement decay sweep — find facts with decay_score < 0.1, move to project/archive/
- [x] 13.3 Implement semantic deduplication — find fact pairs with embedding similarity > 0.95, merge content, invalidate duplicate
- [x] 13.4 Implement context consolidation — find clusters of 3+ context facts with similarity > 0.80 (placeholder — full LLM summarization deferred)
- [x] 13.5 Implement orphan cleanup — archive fast-decay facts unaccessed for 90+ days
- [x] 13.6 Implement index rebuild verification — compare vector index entries vs filesystem, rebuild if >20% discrepancy
- [x] 13.7 Implement GC trigger logic — after N thread completions (default 10), on startup if >24h since last GC
- [x] 13.8 Implement GC audit trail — descriptive git commits for each GC action

## 14. Operator & Team Knowledge

- [x] 14.1 Implement operator profile read/create — read PROFILE.md with frontmatter
- [x] 14.2 Implement team knowledge read — template files created (ROSTER.md, ownership.md, norms.md)
- [x] 14.3 Implement write protection — CONVENTIONS.md and team/ files are human-editable templates only
- [x] 14.4 Implement session metadata tracking — create/update sessions/{thread-id}/meta.md on thread start/completion

## 15. Integration & Configuration

- [x] 15.1 Add memory configuration env vars — MEMORY_EMBEDDING_PROVIDER, MEMORY_OLLAMA_MODEL, MEMORY_OLLAMA_URL, OPENAI_API_KEY, MEMORY_RECALL_LIMIT, MEMORY_GC_INTERVAL
- [x] 15.2 Create PaisleyPark singleton/factory in server startup — initialize once, shared across route handlers and agent runner
- [x] 15.3 Add GC trigger hook to thread completion flow via memoryGCHandler in handler-registry
- [x] 15.4 Verify end-to-end flow: server boots cleanly with 31 handlers including memory GC handler
