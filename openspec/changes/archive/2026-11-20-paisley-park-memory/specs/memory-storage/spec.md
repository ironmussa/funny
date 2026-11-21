## ADDED Requirements

### Requirement: Project memory directory initialization

The system SHALL create a git-backed memory directory at `~/.funny/memory/{project-id}/` when memory is first accessed for a project. The directory SHALL be initialized as a git repository with an initial commit. The directory structure SHALL include `project/facts/`, `project/INDEX.md`, `project/CONVENTIONS.md`, `operators/`, `team/`, and `sessions/` subdirectories.

#### Scenario: First memory access for a project

- **WHEN** any memory operation (recall, add, search) is called for a project that has no memory directory
- **THEN** the system creates `~/.funny/memory/{project-id}/` with a `.git/` repository and all subdirectories, commits the initial structure, and proceeds with the requested operation

#### Scenario: Memory directory already exists

- **WHEN** a memory operation is called for a project whose memory directory already exists
- **THEN** the system uses the existing directory without modification

#### Scenario: Corrupted or missing git repo

- **WHEN** the memory directory exists but `.git/` is missing or corrupted
- **THEN** the system re-initializes the git repository and creates an initial commit with all existing files

### Requirement: Memory fact file format

Each memory fact SHALL be stored as a markdown file in `project/facts/` with YAML frontmatter containing all 16 metadata fields. The filename SHALL be the fact ID with `.md` extension (e.g., `fact-2026-03-12-a7f3.md`). The fact ID SHALL be generated as `fact-{YYYY-MM-DD}-{4-char-hex}` where the hex portion is derived from a random UUID.

#### Scenario: Creating a new fact file

- **WHEN** `add()` is called with content and metadata
- **THEN** the system creates a file at `project/facts/{fact-id}.md` with complete YAML frontmatter (id, type, confidence, source_agent, source_operator, source_session, valid_from, invalid_at, ingested_at, invalidated_by, superseded_by, tags, related, decay_class, access_count, last_accessed) followed by the content body

#### Scenario: Reading a fact file

- **WHEN** the system reads a fact file from disk
- **THEN** it parses the YAML frontmatter using `gray-matter` and returns a typed `MemoryFact` object with all metadata fields and the content body

### Requirement: Git commit on every write

Every write operation (create, update, invalidate) SHALL result in a git commit in the project's memory repository. The commit message SHALL be descriptive and follow the pattern `memory({operation}): {description}`.

#### Scenario: Adding a new fact

- **WHEN** a new fact is created via `add()`
- **THEN** the system stages the new file and creates a commit with message `memory(add): {type} - {first 60 chars of content}`

#### Scenario: Invalidating a fact

- **WHEN** a fact is invalidated via `invalidate()`
- **THEN** the system updates the fact's frontmatter (sets `invalid_at`, `invalidated_by`), stages the change, and commits with message `memory(invalidate): {fact-id} - {reason}`

#### Scenario: Evolving a fact

- **WHEN** a fact is updated via `evolve()`
- **THEN** the system updates the content and relevant frontmatter, stages the change, and commits with message `memory(evolve): {fact-id} - {first 60 chars of update}`

### Requirement: Concurrent write safety

The system SHALL use a write lock to prevent concurrent git operations from corrupting the memory repository. Read operations SHALL NOT require the lock.

#### Scenario: Two agents add facts simultaneously

- **WHEN** two threads call `add()` at the same time for the same project
- **THEN** one acquires the write lock and completes, the second waits for the lock and then completes — both facts are committed in separate commits with no corruption

#### Scenario: Read during write

- **WHEN** one thread calls `add()` while another calls `recall()`
- **THEN** the recall operation reads the filesystem without waiting for the write lock and returns results based on the current state of files on disk

### Requirement: INDEX.md auto-generation

The system SHALL maintain an `INDEX.md` file in `project/` that provides a summary of all active (non-invalidated) facts. The index SHALL be regenerated after each write operation. The first 200 lines of INDEX.md SHALL be designed for injection into agent context.

#### Scenario: Index regeneration after add

- **WHEN** a new fact is added
- **THEN** INDEX.md is regenerated to include the new fact, grouped by type (decisions, bugs, patterns, conventions, insights, context), sorted by recency within each group

#### Scenario: Index after invalidation

- **WHEN** a fact is invalidated
- **THEN** INDEX.md is regenerated without the invalidated fact

### Requirement: Filesystem as source of truth

The git-backed filesystem SHALL be the authoritative source. All derived indexes (vector index, graph, INDEX.md) SHALL be rebuildable from the filesystem alone. If any derived index is lost or corrupted, it SHALL be reconstructable by scanning all `.md` files in `project/facts/`.

#### Scenario: Vector index lost

- **WHEN** the `.index/vectors.db` file is deleted or corrupted
- **THEN** the system detects the missing index on next access, re-reads all fact files, re-embeds their content, and rebuilds the vector index

#### Scenario: Manual fact file edit

- **WHEN** a human edits a fact file directly (changes content or frontmatter) and commits
- **THEN** the next read of that fact reflects the human's changes — the system does not overwrite manual edits
