# memory-gc Specification

## Purpose

TBD - created by archiving change paisley-park-memory. Update Purpose after archive.

## Requirements

### Requirement: Decay sweep

The GC agent SHALL identify facts with decay scores below the threshold of 0.1 and move them to an `archive/` directory within the memory repository. Archived facts SHALL remain accessible for timeline queries but SHALL NOT appear in recall results.

#### Scenario: Archiving a decayed fact

- **WHEN** the GC agent runs and finds a fact with `decay_class: fast` and `last_accessed` 60+ days ago (decay score < 0.1)
- **THEN** the fact file is moved from `project/facts/` to `project/archive/`, its entry is removed from the vector index and graph, INDEX.md is regenerated, and a git commit is created with message `memory(gc): archive {fact-id} below decay threshold`

#### Scenario: Slow-decay fact preserved

- **WHEN** the GC agent runs and finds a fact with `decay_class: slow` and `last_accessed` 200 days ago (decay score ≈ 0.55)
- **THEN** the fact is NOT archived because its decay score is above the threshold

#### Scenario: Archived facts excluded from recall

- **WHEN** `recall()` is called after facts have been archived
- **THEN** archived facts are NOT included in the candidate set for ranking

#### Scenario: Archived facts included in timeline

- **WHEN** `timeline()` is called with `includeInvalidated: true`
- **THEN** archived facts ARE included in the chronological listing

### Requirement: Semantic deduplication

The GC agent SHALL identify pairs of active facts with embedding similarity > 0.95 and merge them into a single fact. The merged fact SHALL combine the content of both, and the duplicate SHALL be invalidated with `superseded_by` pointing to the merged fact.

#### Scenario: Merging duplicate facts

- **WHEN** the GC agent finds two active facts with embedding similarity 0.97
- **THEN** the fact with higher confidence (or more recent if tied) is kept as the primary, its content is updated to incorporate information from the duplicate, the duplicate is invalidated with `superseded_by` set to the primary's ID, and a git commit records `memory(gc): merge duplicate facts → {primary-id}`

#### Scenario: Near-duplicate below threshold

- **WHEN** the GC agent finds two facts with embedding similarity 0.93
- **THEN** no merge is performed — the facts remain independent

#### Scenario: No embedding provider available

- **WHEN** the GC agent runs deduplication but no embedding provider is configured
- **THEN** the deduplication step is skipped with a warning logged

### Requirement: Context consolidation

The GC agent SHALL identify clusters of 3+ active facts of type `context` on the same topic (determined by embedding similarity > 0.80 within the cluster) and consolidate them into a single `insight` fact. The original context facts SHALL be invalidated with `superseded_by` pointing to the new insight.

#### Scenario: Consolidating context facts

- **WHEN** the GC agent finds 5 context facts about "Redis configuration" with mutual embedding similarity > 0.80
- **THEN** a new insight fact is created with consolidated content, all 5 context facts are invalidated with `superseded_by` set to the new insight's ID, and a git commit records `memory(gc): consolidate 5 context facts → insight {new-id}`

#### Scenario: Fewer than 3 related context facts

- **WHEN** the GC agent finds only 2 context facts on a topic
- **THEN** no consolidation is performed

### Requirement: Orphan cleanup

The GC agent SHALL identify facts with `decay_class: fast` that have not been accessed in 90+ days and archive them regardless of their decay score.

#### Scenario: Orphan fast-decay fact

- **WHEN** a fact with `decay_class: fast` has `last_accessed` 95 days ago and `access_count: 1`
- **THEN** the fact is moved to `project/archive/` with commit message `memory(gc): archive orphan {fact-id} (unaccessed 95 days)`

#### Scenario: Frequently accessed fast-decay fact

- **WHEN** a fact with `decay_class: fast` has `last_accessed` 2 days ago and `access_count: 50`
- **THEN** the fact is NOT archived — it is actively used despite its fast decay class

### Requirement: Index rebuild

The GC agent SHALL verify that the vector index is synchronized with the filesystem. If discrepancies are found (facts in filesystem not in index, or vice versa), the index SHALL be rebuilt from scratch.

#### Scenario: Missing facts in vector index

- **WHEN** the GC agent finds 5 fact files in `project/facts/` that are not indexed in `vectors.db`
- **THEN** the system embeds the missing facts and adds them to the index, logging `memory(gc): re-indexed 5 missing facts`

#### Scenario: Stale entries in vector index

- **WHEN** the GC agent finds entries in `vectors.db` for fact IDs that no longer exist as files
- **THEN** the stale entries are removed from the index

#### Scenario: Full index rebuild

- **WHEN** discrepancies exceed 20% of total facts
- **THEN** the entire index is dropped and rebuilt from scratch rather than patching individual entries

### Requirement: GC execution triggers

The GC agent SHALL be triggerable via: (a) a REST endpoint `POST /api/projects/:projectId/memory/gc`, (b) automatically after every N thread completions (configurable, default 10), and (c) on application startup if last GC was more than 24 hours ago.

#### Scenario: Manual GC trigger via API

- **WHEN** `POST /api/projects/:projectId/memory/gc` is called
- **THEN** the GC agent runs all steps (decay sweep, dedup, consolidation, orphan cleanup, index rebuild) and returns a summary of actions taken

#### Scenario: Automatic GC after N threads

- **WHEN** 10 threads have completed since the last GC run for a project
- **THEN** the GC agent is triggered automatically in the background

#### Scenario: GC on startup

- **WHEN** the server starts and the last GC for a project was more than 24 hours ago
- **THEN** the GC agent runs in the background after startup completes

### Requirement: GC audit trail

Every GC action SHALL be recorded as a descriptive git commit in the project's memory repository. The commit messages SHALL follow the pattern `memory(gc): {action} {details}`.

#### Scenario: GC commit log

- **WHEN** the GC agent archives 3 facts, merges 1 duplicate pair, and consolidates 5 context facts in a single run
- **THEN** the git log shows 3 separate commits: one for archival, one for merge, one for consolidation — each with descriptive messages
