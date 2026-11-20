## Purpose

Provide fast, relevant file and content search within the exact project, worktree, or scratch directory associated with a Funny request through one resident FFF backend with explicit health and failure behavior.

## ADDED Requirements

### Requirement: Search is scoped to an authorized working directory

The system SHALL resolve every file or content search to the authorized project, thread worktree, or scratch working directory before querying any search backend. Search results MUST NOT include paths outside that resolved directory.

#### Scenario: Worktree thread search

- **WHEN** a user searches from a worktree thread they own
- **THEN** the system searches the thread's worktree rather than the project's base checkout

#### Scenario: Unauthorized path search

- **WHEN** a user requests a search for a path outside their accessible projects and threads
- **THEN** the system rejects the request before initializing or querying a search backend

### Requirement: File search returns ranked repository-relative results

The system SHALL support ranked file search over repository-relative paths, SHALL respect ignored files, and SHALL cap results at the requested limit or the system maximum. When the resident backend is active, ranking SHALL support fuzzy path matching and MAY incorporate recent access, modification time, and Git status without changing path correctness.

#### Scenario: Fuzzy file query

- **WHEN** a user enters a query whose characters or words approximately identify a file but do not form an exact substring
- **THEN** the system returns matching repository-relative paths ordered by relevance

#### Scenario: Result limit

- **WHEN** more files match than the allowed result limit
- **THEN** the system returns only the allowed number and indicates that the result set was truncated

#### Scenario: Ignored file

- **WHEN** a path is excluded by the repository ignore rules
- **THEN** the path does not appear in file search results

### Requirement: Content search preserves existing query semantics

The system SHALL support plain-text and regular-expression content search with case-sensitivity, whole-word, include-glob, exclude-glob, and maximum-result options. Results SHALL contain repository-relative file paths, one-based line numbers, line text, highlight ranges, total matches, truncation state, duration, and the resolved base path.

#### Scenario: Plain-text content search

- **WHEN** a user submits a plain-text query with supported filters
- **THEN** the system returns grouped file matches with the same observable fields regardless of the selected backend

#### Scenario: Supported option translation

- **WHEN** a user combines whole-word, case, regular-expression, include-glob, or exclude-glob options
- **THEN** the system translates and applies those semantics through the resident search engine without invoking another search backend

#### Scenario: Invalid regular expression

- **WHEN** a user submits an invalid expression in regular-expression mode
- **THEN** the system returns a controlled validation or search error and remains available for later searches

### Requirement: Search indexes remain fresh

The system SHALL make filesystem changes visible to subsequent searches without requiring a runtime restart. Git operations that can replace many files or change branches SHALL trigger a refresh or invalidation of the affected working-directory index.

#### Scenario: File created during a thread

- **WHEN** an agent creates a non-ignored file in the active working directory
- **THEN** a subsequent file or content search can discover the new file after the watcher update is processed

#### Scenario: Branch-changing Git operation

- **WHEN** a Git operation changes the checked-out tree for an indexed working directory
- **THEN** the system refreshes or rebuilds that directory's index before relying on stale search state

### Requirement: Resident search failures are explicit

FFF SHALL be the only production backend for file and content search. If its native binding is unavailable, initialization fails, or a query fails, the system SHALL return a controlled search-unavailable or search-failed error and SHALL NOT invoke the former file-index or ripgrep implementations.

#### Scenario: Native dependency unavailable

- **WHEN** the runtime starts on a platform where the resident backend cannot load
- **THEN** search health reports an unavailable state and search requests return a controlled unavailable error

#### Scenario: Resident query failure

- **WHEN** an initialized resident backend returns an error for a search
- **THEN** the system records the failure and returns a controlled search error without invoking another backend

### Requirement: Resident resources have bounded lifetimes

The system SHALL share at most one active resident index for equivalent canonical working-directory paths within a runtime process. Idle, deleted, invalidated, and shutdown indexes SHALL release their native resources and filesystem watchers.

#### Scenario: Concurrent searches in one worktree

- **WHEN** multiple requests search the same worktree concurrently
- **THEN** they reuse one initialized index or one shared initialization operation

#### Scenario: Worktree deletion

- **WHEN** Funny removes a worktree that has a resident index
- **THEN** the system disposes that index and its watchers

#### Scenario: Runtime shutdown

- **WHEN** the runner shuts down
- **THEN** all resident indexes are disposed before shutdown completes

### Requirement: Search backend operation is observable

The system SHALL expose logs or diagnostics identifying FFF version, initialization state, indexed file count when available, native failure reason, and search duration without revealing searched file contents or query text.

#### Scenario: Native failure diagnosis

- **WHEN** a resident search attempt fails
- **THEN** diagnostics identify the affected working directory in a safe form and a non-sensitive failure reason

#### Scenario: Search telemetry

- **WHEN** a search completes
- **THEN** telemetry records its operation type, duration, result count, and truncation state without recording the query or matched content

### Requirement: Replacement is informed by comparative evidence

The system SHALL record an automated comparison of result compatibility and repeated-query performance on representative small and large repositories before replacing the existing production search paths. A product decision MAY explicitly accept measured regressions when consolidation is prioritized, but the results and accepted trade-offs MUST remain documented.

#### Scenario: Benchmark gate passes

- **WHEN** FFF preserves the required file/content search semantics, improves warm-query latency by at least 20 percent at p50 or p95 for both search types, and does not regress cold readiness by more than 25 percent
- **THEN** implementation may remove the former file-index, client scorer, and per-query ripgrep paths

#### Scenario: Benchmark gate fails

- **WHEN** correctness parity fails or the required performance threshold is not met
- **THEN** implementation reports the measurements and incompatibility and proceeds only after an explicit product decision accepting the trade-offs

#### Scenario: Product accepts benchmark regressions

- **WHEN** the benchmark fails and the product explicitly prioritizes one FFF implementation over the measured file-search and readiness regressions
- **THEN** FFF becomes the sole production backend without a legacy fallback and the benchmark remains part of the operational documentation
