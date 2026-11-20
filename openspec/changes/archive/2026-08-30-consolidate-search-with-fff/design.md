## Context

See `proposal.md` for motivation. Today file navigation and content search have independent caches and execution paths. The runtime's file index uses `git ls-files` plus `fs.watch`, while content search spawns `rg --json` for each request. The client copies the full file list into IndexedDB and a Web Worker for Ctrl+P scoring. Every request is authorized and resolved to a project, worktree, or scratch cwd before entering these services; that boundary must remain outside the search backend.

FFF is a native Rust/C dependency exposed to Bun and Node through `@ff-labs/fff-node`. It owns a filesystem watcher, supports path/glob/content search, and must be explicitly destroyed. Funny packages for several operating systems and can run many worktrees concurrently, so native loading, watcher count, memory, and lifecycle are primary constraints.

## Goals / Non-Goals

**Goals:**

- Establish one runtime search contract for file listing, ranked file search, and content search.
- Reuse one resident FFF instance per canonical cwd across Funny UI requests.
- Preserve authorization, endpoint compatibility, result caps, and text-search semantics.
- Measure correctness and performance before replacement, record the accepted regressions, then run FFF as the only backend by explicit product decision.
- Allow a later client migration from full-index transfer to server-ranked results without coupling React code to FFF.

**Non-Goals:**

- Replacing symbol search, LSP, thread/message search, or project memory.
- Replacing agent-native grep tools or adding the FFF MCP server in this change.
- Sharing one index between different worktrees; their contents can diverge.
- Persisting a content inverted index or sending repository contents to the central team server.

## Decisions

### Introduce a backend-neutral runtime contract

Create a `ProjectSearchProvider` contract with operations equivalent to `listFiles`, `searchFiles`, `searchText`, `refresh`, `health`, and `dispose`. The production implementation adapts FFF native results to Funny-owned response types. The old implementations remain only as benchmark baselines until the gate passes, then are removed.

Routes continue to resolve authorization and cwd before calling this contract. FFF types do not cross the runtime service boundary or appear in client/shared API types.

Alternative considered: call FFF directly from existing routes. Rejected because it would duplicate lifecycle, metrics, and result adaptation across file and text endpoints.

### Benchmark first, then require FFF by explicit product decision

Build a repeatable comparison using the existing implementations strictly as baselines. The gate requires semantic parity for current API options, at least a 20% p50 or p95 warm-latency improvement for both ranked file and content search, and no more than a 25% regression in cold readiness. Measure the current repository plus a generated or checked-out large fixture and a multi-worktree case.

The corrected benchmark failed: FFF improved warm content search, but regressed file search and readiness on the identical 10,001-file corpus. On 2026-08-30 the product explicitly accepted those regressions to prioritize a single maintained search implementation. FFF is therefore loaded as a required production dependency. Native load, initialization, or query errors become controlled domain errors and health failures. There is no runtime selector and no alternate search backend. Existing semantics absent from a direct FFF option are implemented by safe query translation, constraint parsing, or Funny-owned result adaptation.

Alternative considered: retain a selectable legacy backend. Rejected per product decision because maintaining two paths would preserve the duplication this change is intended to remove.

### Manage resident instances in a bounded registry

Add a runtime-owned registry keyed by a canonical absolute cwd. Each entry holds a shared initialization promise, provider instance, last-used time, active request count, and health state. Concurrent first requests await the same initialization. Entries are not evicted while a query is active.

Use a configurable idle TTL and maximum entry count, initially 10 minutes and 8 resident indexes per runtime. Eviction calls `destroy()`. Explicit invalidation on worktree/scratch deletion and runtime shutdown also disposes entries. Project base checkout and every worktree remain separate keys. Benchmarks may tune these defaults without changing the contract.

Alternative considered: one FFF process or instance per agent. Rejected because multiple agents can search the same cwd and would duplicate memory and watchers.

### Store search state outside repositories

FFF frecency and query-history databases live under the runner's Funny data directory, partitioned by a stable hash of the canonical cwd and the runner/user scope. Raw absolute paths are not used as directory names and state is never written into a project checkout. Selecting a file through Funny records the query/file choice only when an explicit tracking operation is added to the file-open flow; search alone must not invent an access event.

Alternative considered: use FFF's implicit/default database paths. Rejected because Funny needs predictable cleanup and isolation between users and projects.

### Preserve existing APIs, then migrate Ctrl+P incrementally

After the benchmark gate passes, existing file-index and text-search routes consume the FFF provider contract. Add `GET /api/search/files`, following the existing text-search route's `path`/`threadId` authorization model, and return `path`, highlight indices, total, truncation state, and resolved base path. Highlight indices are computed in Funny when the native API supplies ranking but not character positions.

Move `FileSearchDialog` to cancellable debounced server-ranked queries. Once its regression tests pass, remove the full-index transfer, IndexedDB file cache, Web Worker scorer, legacy file-index service, and ripgrep service/dependency.

Alternative considered: keep the browser-side scorer. Rejected because it duplicates ranking, requires transferring the complete index, and prevents one authoritative frecency-aware order.

### Combine FFF watches with Funny's domain invalidation

FFF's watcher handles ordinary file creation, modification, and deletion. Funny's existing `git:changed` signal calls `refreshGitStatus` for status-only changes and schedules a rescan for operations that may replace the tree. Worktree and scratch lifecycle events invalidate their exact registry key.

Alternative considered: rely exclusively on the native watcher. Rejected because branch switches and watcher overflow require domain-aware refreshes.

### Keep telemetry backend-neutral and content-free

Extend existing search metrics with operation, indexed-file count, duration, result count, truncation, and native error category. Logs may include a hashed cwd identifier but not the query, line contents, or matched paths at info level. A health method reports native version, scan state, watcher/index state, and failure reason for diagnostics.

## Risks / Trade-offs

- [Native package fails on a supported target or packaged Tauri build] → Treat platform verification as a release gate and report search unavailable rather than silently changing behavior.
- [Many active worktrees consume excessive RSS or file descriptors] → Bound the registry, evict idle entries, expose counts/RSS in benchmarks, and dispose on thread/worktree cleanup.
- [FFF and ripgrep return observably different results] → Use contract tests against shared fixtures and stop replacement until query translation preserves required semantics.
- [Watcher races return stale results immediately after Git operations] → Wire domain invalidation and add eventual-freshness tests with explicit scan readiness where needed.
- [Frecency leaks activity between users or unrelated checkouts] → Partition state by runner/user scope and canonical-cwd hash; do not store it in a global FFF default database.
- [Server-ranked Ctrl+P adds network latency] → Debounce/cancel requests, cap responses, and include end-to-end typing latency in the replacement gate.
- [Native synchronous calls block Bun's event loop] → Benchmark query and scan behavior; move expensive initialization or calls to an isolated worker/process if measured event-loop delay exceeds the agreed budget.

## Migration Plan

1. Add a standalone benchmark adapter for FFF and compare it with the current file-index/ripgrep paths without altering production routing.
2. Report and retain correctness and performance results; require an explicit product decision if the gate fails.
3. Following the recorded product acceptance, add the FFF provider and bounded registry as required runtime infrastructure.
4. Route existing APIs through FFF and add server-ranked file search.
5. Migrate Ctrl+P, then delete the browser index/scorer and runtime legacy implementations.
6. Verify native loading across supported release targets before release.

Rollback is source/release rollback, not runtime fallback. FFF state databases are caches and can be deleted after their instances are disposed; no durable data migration is required.

## Open Questions

- The acceptable event-loop-delay gate and any later tuning of the initial 10-minute/8-index registry limits will be chosen from benchmark evidence before changing the default backend.
