# memory-api Specification

## Purpose
TBD - created by archiving change paisley-park-memory. Update Purpose after archive.

## Requirements

### Requirement: PaisleyPark class instantiation

The system SHALL provide a `PaisleyPark` class that is instantiated with a project ID and optional configuration. The class SHALL lazily initialize the memory directory and indexes on first access.

#### Scenario: Creating a PaisleyPark instance

- **WHEN** `new PaisleyPark({ projectId: "proj-123" })` is called
- **THEN** a PaisleyPark instance is created without performing any filesystem or git operations — initialization is deferred to first use

#### Scenario: First operation triggers initialization

- **WHEN** the first `recall()` or `add()` call is made on a new instance
- **THEN** the system checks for the memory directory, creates it if needed, loads the graph index, and verifies the vector index

### Requirement: recall() — automatic context retrieval

The `recall(query, options?)` method SHALL return the most relevant active facts for a given query. It SHALL combine embedding search, keyword search, and graph traversal, then rank and deduplicate results. Default limit SHALL be 10.

#### Scenario: Basic recall

- **WHEN** `recall("rate limiting API")` is called with no options
- **THEN** the system returns up to 10 active facts ranked by combined relevance and decay score

#### Scenario: Recall with scope filter

- **WHEN** `recall("rate limiting", { scope: "project" })` is called
- **THEN** only facts from the `project/` scope are returned (excluding operator and team facts)

#### Scenario: Recall with minimum confidence

- **WHEN** `recall("redis", { minConfidence: 0.8 })` is called
- **THEN** only facts with `confidence >= 0.8` are included in results

#### Scenario: Recall as of a past date

- **WHEN** `recall("API design", { asOf: new Date("2026-03-01") })` is called
- **THEN** only facts that were valid on March 1, 2026 are returned (temporal filter applied)

#### Scenario: Recall for a specific operator

- **WHEN** `recall("coding style", { forOperator: "argenis" })` is called
- **THEN** results include operator-specific preferences from `operators/argenis/PROFILE.md` in addition to project facts

### Requirement: add() — create new memory fact

The `add(content, options)` method SHALL create a new fact file with full frontmatter, run conflict detection, update indexes, and commit to git. It SHALL return the created `MemoryFact`.

#### Scenario: Adding a decision fact

- **WHEN** `add("We use cursor-based pagination", { type: "decision", tags: ["api", "pagination"], confidence: 0.92 })` is called
- **THEN** a new fact file is created with all 16 frontmatter fields populated, conflict detection is run, the vector index is updated, the graph is updated, INDEX.md is regenerated, and a git commit is created

#### Scenario: Adding with auto-inferred decay class

- **WHEN** `add("...", { type: "decision" })` is called without explicit `decayClass`
- **THEN** the decay class is inferred from the type: decisions → slow, bugs → normal, patterns → slow, conventions → slow, insights → normal, context → fast

#### Scenario: Adding with related facts

- **WHEN** `add("...", { type: "bug", relatedTo: ["fact-2026-03-08-b2c1"] })` is called
- **THEN** the new fact's `related` field includes the specified IDs, and the referenced facts' `related` fields are updated to include the new fact ID (bidirectional linking)

### Requirement: invalidate() — mark fact as no longer valid

The `invalidate(factId, reason?)` method SHALL mark a fact as invalid without deleting it. It SHALL update frontmatter, regenerate INDEX.md, and commit to git.

#### Scenario: Invalidating an active fact

- **WHEN** `invalidate("fact-2026-03-08-b2c1", "Bug was fixed in PR #350")` is called
- **THEN** the fact's `invalid_at` is set to now, the reason is recorded, INDEX.md is regenerated without this fact, and a git commit is created

#### Scenario: Invalidating an already-invalid fact

- **WHEN** `invalidate()` is called on a fact that already has `invalid_at` set
- **THEN** the system returns an error indicating the fact is already invalidated

### Requirement: evolve() — update fact without invalidating

The `evolve(factId, update)` method SHALL append or update a fact's content while preserving its validity. It SHALL update the vector index with the new content and commit to git.

#### Scenario: Evolving an active fact

- **WHEN** `evolve("fact-2026-03-08-b2c1", "Update: the cursor is now base64-encoded as of v2.4")` is called
- **THEN** the fact's content is updated, `ingested_at` is refreshed, the embedding is re-computed, and a git commit records the change

#### Scenario: Evolving an invalidated fact

- **WHEN** `evolve()` is called on a fact with `invalid_at` set
- **THEN** the system returns an error — invalidated facts cannot be evolved

### Requirement: search() — explicit filtered search

The `search(query, filters?)` method SHALL provide explicit search with type, tag, temporal, and confidence filters. Unlike `recall()`, search does not automatically format results or include graph traversal unless requested.

#### Scenario: Search by type

- **WHEN** `search("redis", { type: "bug" })` is called
- **THEN** only facts of type "bug" matching the query "redis" are returned

#### Scenario: Search by date range

- **WHEN** `search("API", { createdAfter: new Date("2026-03-01"), createdBefore: new Date("2026-03-15") })` is called
- **THEN** only facts ingested within that date range are returned

#### Scenario: Search including invalidated facts

- **WHEN** `search("pagination", { validAt: new Date("2026-02-15") })` is called
- **THEN** facts that were valid on Feb 15 are returned, even if they are now invalidated

### Requirement: timeline() — chronological fact history

The `timeline(options?)` method SHALL return facts in chronological order by `ingested_at`. It SHALL include invalidated facts by default (for audit purposes).

#### Scenario: Full timeline

- **WHEN** `timeline()` is called with no options
- **THEN** all facts (active and invalidated) are returned ordered by `ingested_at` ascending

#### Scenario: Timeline with type filter

- **WHEN** `timeline({ type: "decision" })` is called
- **THEN** only decision-type facts are returned, in chronological order, including invalidated decisions

#### Scenario: Timeline with date range

- **WHEN** `timeline({ from: new Date("2026-03-01"), to: new Date("2026-03-15") })` is called
- **THEN** only facts ingested within that range are returned

### Requirement: MCP Server tools

The system SHALL expose memory operations as MCP tools via a stdio transport server. Tools SHALL include: `pp_recall`, `pp_add`, `pp_invalidate`, `pp_search`.

#### Scenario: MCP pp_recall tool

- **WHEN** an external agent calls the `pp_recall` tool with `{ query: "rate limiting", limit: 5 }`
- **THEN** the MCP server calls `recall()` with the given parameters and returns formatted results

#### Scenario: MCP pp_add tool

- **WHEN** an external agent calls `pp_add` with `{ content: "...", type: "decision", tags: ["api"] }`
- **THEN** the MCP server calls `add()` and returns the created fact

#### Scenario: MCP pp_invalidate tool

- **WHEN** an external agent calls `pp_invalidate` with `{ factId: "fact-2026-03-12-a7f3", reason: "No longer true" }`
- **THEN** the MCP server calls `invalidate()` and confirms the operation

#### Scenario: MCP pp_search tool

- **WHEN** an external agent calls `pp_search` with `{ query: "redis", type: "bug", tags: ["cluster"] }`
- **THEN** the MCP server calls `search()` with the given filters and returns matching facts

### Requirement: REST API routes

The system SHALL expose memory operations as REST endpoints under `/api/projects/:projectId/memory/` for use by the Funny web client and admin tools.

#### Scenario: GET /api/projects/:projectId/memory/recall

- **WHEN** a GET request is made with `?query=rate+limiting&limit=10`
- **THEN** the server calls `recall()` and returns the results as JSON

#### Scenario: POST /api/projects/:projectId/memory/facts

- **WHEN** a POST request is made with `{ content, type, tags, confidence }`
- **THEN** the server calls `add()` and returns the created fact as JSON

#### Scenario: PATCH /api/projects/:projectId/memory/facts/:factId/invalidate

- **WHEN** a PATCH request is made with `{ reason }`
- **THEN** the server calls `invalidate()` and returns success

#### Scenario: GET /api/projects/:projectId/memory/timeline

- **WHEN** a GET request is made with optional `?from=&to=&type=` query params
- **THEN** the server calls `timeline()` and returns the chronological list as JSON
