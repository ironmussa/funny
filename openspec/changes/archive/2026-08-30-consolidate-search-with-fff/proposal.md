## Why

Funny currently maintains separate search paths for file navigation and text search: a custom file index copied to the browser for client-side scoring, and a new ripgrep process for every content query. A shared resident search engine can improve warm-query latency and result quality for large repositories while reducing duplicated indexing and search logic.

## What Changes

- Introduce a runtime-owned project code-search capability backed by a resident FFF index per resolved working directory.
- Route file navigation and text search through a common search-provider contract while preserving their existing HTTP response shapes and authorization boundaries.
- Benchmark FFF against the current file-index and ripgrep paths before migration and retain the measurements as an explicit product trade-off record.
- Replace the current file-index, client-side scorer, and per-query ripgrep implementation by explicit product decision despite the failed performance gate; FFF becomes the only production backend and failures are surfaced explicitly.
- Add lifecycle management for project, worktree, and scratch indexes, including invalidation after git changes and idle eviction.
- Add configuration, health diagnostics, telemetry, and benchmarks so FFF can be enabled incrementally and compared against the existing implementation.
- Preserve the existing symbol-search implementation; FFF definition hints are search metadata, not a replacement for semantic symbol indexing.

## Capabilities

### New Capabilities

- `project-code-search`: Unified, working-directory-scoped file and content search with resident indexing, explicit failure behavior, result limits, and lifecycle guarantees.

### Modified Capabilities

None.

## Impact

- Runtime services and routes: `file-index-service.ts`, `text-search-service.ts`, `/api/browse/files/index`, `/api/browse/files`, and `/api/search/text`.
- Client file navigation: `file-index-store.ts`, `FileSearchDialog.tsx`, and the file-search Web Worker can be simplified after server-side ranked search is proven.
- Runtime lifecycle: git-change invalidation, worktree cleanup, scratch-thread cleanup, shutdown, metrics, and diagnostics.
- Dependencies and distribution: adds the native FFF Node/Bun binding and its platform artifacts; packaged builds and CI need compatibility coverage.
- Public endpoint behavior remains compatible, but deployment now requires a supported and healthy FFF native binding.
