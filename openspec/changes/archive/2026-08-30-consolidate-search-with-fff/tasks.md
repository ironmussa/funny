## 1. Comparative Gate

- [x] 1.1 Add a pinned FFF Node/Bun dependency and a benchmark-only adapter without changing production search routing.
- [x] 1.2 Add shared correctness fixtures covering ignore behavior, fuzzy ranking, plain/regex text, smart case, whole word, include/exclude globs, result caps, paths, lines, ranges, truncation, and invalid regex.
- [x] 1.3 Add a repeatable comparison for cold readiness, warm file/content p50/p95, RSS, watcher count, event-loop delay, and multi-worktree behavior on small and large repositories.
- [x] 1.4 Run the comparison, record results, and evaluate whether semantics and performance meet the original replacement gate.
- [x] 1.5 Correct the comparison to isolate backend processes, alternate execution order across repeated rounds, report file/content readiness separately, tune FFF thread count explicitly, and rerun the replacement gate.
- [x] 1.6 Record the explicit product decision to accept the measured file-search/readiness regressions and proceed with FFF as the sole implementation without fallback.

## 2. Provider Foundation

- [x] 2.1 Define Funny-owned file-list, ranked-file-search, content-search, health, refresh, and disposal contracts without exposing FFF types outside the runtime service layer.
- [x] 2.2 Implement FFF as the required provider for file listing, ranked fuzzy file search, plain/regex content search, health, Git refresh, rescan, and disposal.
- [x] 2.3 Translate whole-word and include/exclude-glob behavior through FFF and map results into existing Funny response types.
- [x] 2.4 Return controlled domain errors for native loading, initialization, invalid regex, and query failures without invoking another backend.
- [x] 2.5 Add provider tests for initialization, errors, ignored files, smart case, option translation, result limits, and contract parity.

## 3. Registry and Lifecycle

- [x] 3.1 Implement a canonical-cwd registry that shares concurrent initialization and one active resident instance per working directory.
- [x] 3.2 Add configurable idle eviction and an eight-entry default maximum without disposing entries that have active requests.
- [x] 3.3 Store frecency/query databases under the Funny runner data directory using isolated hashed cwd keys, and add tests proving different cwd/user scopes do not collide.
- [x] 3.4 Connect ordinary filesystem changes, `git:changed` events, and branch-changing operations to the appropriate status refresh or rescan behavior.
- [x] 3.5 Dispose exact entries when worktrees or scratch directories are removed and dispose all entries through the runtime shutdown manager.
- [x] 3.6 Add concurrency and lifecycle tests covering shared initialization, idle/LRU eviction, worktree deletion, active-query protection, and shutdown.

## 4. Runtime Routes and Compatibility

- [x] 4.1 Route the existing file-index and text-search endpoints through the selected provider after their current authorization and cwd resolution checks.
- [x] 4.2 Add `GET /api/search/files` with `path`/`threadId`, query, limit, truncation, highlight indices, and resolved-base-path support.
- [x] 4.3 Add route tests proving project, worktree, scratch, ownership, and denied-path scoping occurs before backend initialization.
- [x] 4.4 Add end-to-end runtime tests showing native load, initialization, and query failures return controlled errors and never spawn ripgrep.

## 5. Ctrl+P Migration and Legacy Removal

- [x] 5.1 Add a client API method and cancellable/debounced ranked-file-search flow using the FFF-backed endpoint.
- [x] 5.2 Update `FileSearchDialog` to render ranked server results, highlighted fuzzy characters, empty/loading/error states, keyboard navigation, and truncation state.
- [x] 5.3 Record an FFF query selection only when a user opens a result, without recording searches as accesses.
- [x] 5.4 Add client tests for ranked results, stale-request cancellation, controlled server errors, scratch base-path resolution, and file opening.
- [x] 5.5 Remove the client file-index store, IndexedDB cache, file-search worker/client, obsolete APIs, and related tests.
- [x] 5.6 Remove the runtime legacy file-index and ripgrep search implementations plus unused ripgrep dependencies and tests.

## 6. Diagnostics and Performance Gates

- [x] 6.1 Emit content-free logs and metrics for operation, initialization/native-error category, duration, result count, indexed count, and truncation.
- [x] 6.2 Expose a diagnostic health view or endpoint with native version, scan state, resident entry count, watcher/index state, and sanitized failure reasons.
- [x] 6.3 Add a repeatable benchmark covering cold scan, warm file/content queries, result parity, RSS, watcher count, and event-loop delay on small/large repositories and multiple worktrees.
- [x] 6.4 Document required native platform support, cache location/cleanup, diagnostics, source/release rollback, and benchmark results.

## 7. Verification

- [x] 7.1 Run focused runtime and client search tests with FFF as the sole backend on a supported platform.
- [x] 7.2 Run `bun run lint` and resolve all findings.
- [x] 7.3 Run `bun run typecheck` and resolve all findings.
- [x] 7.4 Verify packaged native loading for every supported release target and fail the release gate for unsupported targets.
- [x] 7.5 Validate the OpenSpec change strictly and confirm every capability scenario has automated coverage or an explicit verification step.
