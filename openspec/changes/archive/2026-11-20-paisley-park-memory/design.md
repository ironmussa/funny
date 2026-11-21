## Context

Funny orchestrates multiple Claude Code agents in parallel via git worktrees. Each agent thread is an ephemeral Claude CLI process that receives a system prefix containing project instructions and resume context. Currently, agents start with zero knowledge of the project's history — past decisions, known bugs, conventions, and team dynamics are lost between threads.

The agent runner (`agent-runner.ts:330-342`) already composes a `systemPrefix` from `projectSystemPrompt` and `resumePrefix`. This is the natural injection point for memory context.

The database is SQLite via `bun:sqlite` + Drizzle ORM at `~/.funny/data.db`. The app supports single-user (bearer token) and multi-user (Better Auth sessions) modes. Git operations use async utilities in `git-v2.ts`.

## Goals / Non-Goals

**Goals:**

- Agents automatically receive relevant project knowledge when a thread starts — zero friction
- Memory facts are stored as human-readable markdown files with full temporal metadata
- Storage is git-backed for auditability, diffability, and manual editing
- Retrieval combines embedding similarity, keyword search, and relationship graph traversal
- Facts have temporal validity (bi-temporal model) and natural decay over time
- A garbage collection process keeps the memory healthy
- External agents (Cursor, Claude Code CLI) can access memory via MCP tools
- Multi-user mode supports operator-specific preferences and team knowledge

**Non-Goals:**

- Agent self-memory (IDENTITY.md, strategies, mistakes, skills, reflections) — deferred
- Real-time collaborative editing of memory facts
- Cloud sync or remote storage — this is local-first
- Replacing the existing project `systemPrompt` field — memory augments it, doesn't replace it
- UI for memory management in Funny's web client (may come later, not in this change)

## Decisions

### D1: Storage location — `~/.funny/memory/{project-id}/` with standalone git repos

**Decision:** Each project gets its own git repository at `~/.funny/memory/{project-id}/`.

**Alternatives considered:**

- _Inside the project's repo_ (`/my-project/memory/`): Contaminates the project repo with hundreds of `.md` files, causes merge conflicts in worktree branches, triggers CI/CD pipelines on memory writes. Rejected.
- _Single shared directory without git_ (`~/.funny/memory/`): Loses auditability and version history. The git log of memory changes is a valuable feature for debugging and understanding knowledge evolution. Rejected.
- _SQLite tables in `data.db`_: Loses human readability and editability. A developer can't `vim` a fact or `git log` the knowledge history. Rejected.

**Rationale:** Follows the existing pattern where Funny stores application data at `~/.funny/` (the DB is at `~/.funny/data.db`). Git provides version history without external dependencies. Each project gets isolation — deleting a project's memory is `rm -rf ~/.funny/memory/{project-id}`.

### D2: Frontmatter parsing — `gray-matter`

**Decision:** Use the `gray-matter` npm package for parsing YAML frontmatter from markdown files.

**Alternatives considered:**

- _Manual regex parsing_: Fragile, doesn't handle edge cases (multiline values, arrays, nested objects). Rejected.
- _TOML frontmatter_: YAML is more widely recognized in markdown frontmatter conventions. Rejected.

**Rationale:** `gray-matter` is the de facto standard for markdown frontmatter (18M weekly downloads, used by Gatsby, Next.js, Hugo). Zero risk.

### D3: Embedding provider — abstracted, Ollama-first with OpenAI fallback

**Decision:** Define an `EmbeddingProvider` interface. Ship with two implementations: `OllamaEmbeddingProvider` (default, local, free) and `OpenAIEmbeddingProvider` (optional, requires API key). Configuration via environment variables.

```typescript
interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  dimensions(): number;
}
```

**Alternatives considered:**

- _OpenAI-only_: Requires API key, adds cost, network dependency. Not acceptable for a local-first tool. Rejected as default.
- _No embeddings (keyword-only)_: Misses semantic search capabilities that make recall genuinely useful. Rejected.

**Rationale:** Ollama runs locally, supports `nomic-embed-text` (768 dims) and `all-minilm` (384 dims) with good quality. OpenAI `text-embedding-3-small` is a quality upgrade for those willing to pay. The abstraction costs nothing and provides flexibility.

### D4: Vector index — SQLite-vec via bun:sqlite

**Decision:** Use `sqlite-vec` extension loaded into a dedicated SQLite database at `~/.funny/memory/{project-id}/.index/vectors.db`. This is separate from the main `data.db`.

**Alternatives considered:**

- _In-memory HNSW (hnswlib-node)_: Fast but loses index on restart, requiring full re-embedding. With hundreds of facts, re-indexing takes seconds, but it's wasteful. Rejected.
- _pgvector (PostgreSQL)_: Overkill for local usage, adds a database server dependency. Reserved for scale-up path. Rejected for now.
- _Flat brute-force search_: Works for <500 facts but doesn't scale. Using sqlite-vec from the start avoids a migration later.

**Rationale:** Bun natively supports SQLite extensions. `sqlite-vec` provides ANN search with persistence and zero external dependencies. It lives alongside the git-backed facts — if the index is lost, it's rebuilt from the filesystem.

### D5: Graph — in-memory adjacency map rebuilt from frontmatter

**Decision:** On startup (or first access), parse all fact files, extract `related[]` fields, and build an in-memory adjacency map. Graph traversal is a simple BFS/DFS from seed facts.

**Alternatives considered:**

- _Neo4j / FalkorDB_: External graph database is overkill for <1000 facts with shallow relationships. Reserved for scale-up. Rejected.
- _SQLite graph tables_: Adds schema complexity for a structure that fits naturally in memory. Rejected.

**Rationale:** With a practical limit of ~1000 active facts per project, an in-memory `Map<string, Set<string>>` is trivially fast. Rebuild cost is negligible (parse frontmatter of all `.md` files in the facts directory).

### D6: Recall injection point — extend systemPrefix composition in agent-runner.ts

**Decision:** Add memory recall as a third component in the systemPrefix array at `agent-runner.ts:334-342`:

```typescript
const memoryContext = await memoryService.recallForThread(thread, effectivePrompt);

const systemPrefix =
  [
    projectSystemPrompt
      ? `[PROJECT INSTRUCTIONS]\n${projectSystemPrompt}\n[/PROJECT INSTRUCTIONS]`
      : undefined,
    memoryContext ? `[PROJECT MEMORY]\n${memoryContext}\n[/PROJECT MEMORY]` : undefined,
    resumePrefix,
  ]
    .filter(Boolean)
    .join('\n\n') || undefined;
```

**Rationale:** Minimal change to existing code. The memory service handles all complexity (recall, ranking, formatting). The agent runner just receives a formatted markdown string.

### D7: MCP Server — separate process with stdio transport

**Decision:** Ship an MCP server as a separate entry point (`packages/runtime/src/mcp/index.ts`) that external tools (Claude Code CLI, Cursor) can connect to. Uses `@modelcontextprotocol/sdk` with stdio transport.

**Alternatives considered:**

- _HTTP transport_: More complex setup, requires port management, authentication. Stdio is simpler for local tools. Rejected as default.
- _Embedded in the Hono server_: Mixes concerns. The MCP server should be a standalone process that reads from the same filesystem. Rejected.

**Rationale:** Stdio transport is the standard for Claude Code and Cursor MCP integrations. The MCP server instantiates the same `PaisleyPark` class as the main server — one implementation, two access patterns.

### D8: Conflict detection — embedding similarity + LLM classification

**Decision:** When `add()` is called, search for existing facts with embedding similarity > 0.85. For candidates above threshold, use a lightweight LLM call (haiku-class) to classify the relationship: `contradicts`, `extends`, `duplicate`, or `unrelated`. Auto-invalidate only for `contradicts` with confidence > 0.9; otherwise flag for human review.

**Alternatives considered:**

- _No conflict detection_: Facts accumulate contradictions silently. The recall engine returns conflicting information. Rejected.
- _Pure embedding similarity threshold_: Too many false positives — similar facts aren't necessarily contradictory. Rejected.
- _Always auto-invalidate_: Dangerous — could invalidate correct facts based on wrong new information. Rejected.

**Rationale:** The two-stage approach (embedding filter → LLM classification) balances precision with cost. The LLM call is cheap (haiku) and only fires for semantically similar facts, not every add().

### D9: Decay formula and classes

**Decision:** `decay_score = exp(-λ * days_since_last_access)` with λ per decay class:

- `slow` (decisions, conventions, patterns): λ = 0.003/day → half-life ~231 days
- `normal` (bugs, insights, preferences): λ = 0.015/day → half-life ~46 days
- `fast` (context, session-specific): λ = 0.05/day → half-life ~14 days

Facts below `decay_threshold = 0.1` are candidates for GC archival (not deletion).

**Rationale:** Slow-decay facts (architectural decisions) should persist for months. Fast-decay facts (temporary context) should naturally fade in weeks. The threshold of 0.1 means a slow fact survives ~770 days without access, while a fast fact survives ~46 days.

### D10: Service architecture — `packages/runtime/src/services/memory/`

**Decision:** Organize Paisley Park as a service directory within the server package:

```
packages/runtime/src/services/memory/
├── index.ts              # PaisleyPark class — public API
├── storage.ts            # Git-backed filesystem operations
├── temporal.ts           # Bi-temporal engine, conflict detection, decay
├── retrieval.ts          # Embedding, keyword, graph search + ranking
├── embedding.ts          # EmbeddingProvider interface + implementations
├── vector-index.ts       # SQLite-vec wrapper
├── graph.ts              # In-memory relationship graph
├── gc.ts                 # Garbage collection agent
├── formatter.ts          # Format recall results as injectable markdown
├── types.ts              # MemoryFact, RecallOptions, etc.
└── mcp/
    └── server.ts         # MCP server entry point
```

**Rationale:** Keeps memory as a server service alongside existing services (agent-runner, worktree-manager, etc.). No need for a separate package — memory is consumed by the server, not by the client.

## Risks / Trade-offs

- **[Embedding latency on recall]** → First recall may be slow if Ollama isn't running or model isn't cached. Mitigation: Fall back to keyword-only search if embedding provider is unavailable. Cache embeddings in the vector index — subsequent recalls for similar queries are fast.

- **[Git repo grows with thousands of files]** → Performance of `git add` / `git commit` degrades. Mitigation: GC agent aggressively archives stale facts. Limit active facts to ~1000 per project. Use `.gitignore` for the `.index/` directory (derived data, not source of truth).

- **[Conflict detection false positives]** → LLM classifies non-contradictory facts as conflicting, causing incorrect invalidation. Mitigation: Only auto-invalidate at confidence > 0.9. Below that, add a `needs_review` flag but don't invalidate. Log all auto-invalidations in git history for rollback.

- **[Embedding model mismatch]** → Switching embedding models invalidates the entire vector index. Mitigation: Store the model identifier in `.index/meta.json`. On model change, trigger full re-index (parse all fact files, re-embed, rebuild index). This is a one-time cost.

- **[Memory injection bloats system prompt]** → Too many facts consume the agent's context window. Mitigation: Hard cap of 10 facts in automatic recall (configurable). Each fact formatted as 1-3 lines. Total injection stays under ~2000 tokens.

- **[Concurrent writes from multiple threads]** → Two agents adding facts simultaneously could corrupt git state. Mitigation: Use a write lock (file-based or in-memory mutex) around git operations. Reads are lock-free (filesystem reads don't conflict).
