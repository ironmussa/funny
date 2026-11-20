## ADDED Requirements

### Requirement: Bi-temporal tracking

Every memory fact SHALL track two temporal dimensions: assertion time (`valid_from` / `invalid_at` — when the fact was true in the real world) and ingestion time (`ingested_at` — when the system learned the fact). The `valid_from` field SHALL default to the current timestamp. The `invalid_at` field SHALL be `null` for active facts.

#### Scenario: Adding a fact with default temporal values

- **WHEN** `add()` is called without explicit `validFrom`
- **THEN** the fact is created with `valid_from` set to the current ISO timestamp and `invalid_at` set to `null`

#### Scenario: Adding a fact with explicit valid_from

- **WHEN** `add()` is called with `validFrom: "2026-03-01T00:00:00Z"`
- **THEN** the fact is created with `valid_from` set to `"2026-03-01T00:00:00Z"` and `ingested_at` set to the current timestamp

#### Scenario: Querying facts as of a past date

- **WHEN** `recall()` is called with `asOf: "2026-03-05T00:00:00Z"`
- **THEN** the system returns only facts where `valid_from <= "2026-03-05"` AND (`invalid_at` is `null` OR `invalid_at > "2026-03-05"`)

### Requirement: Conflict detection on add

When a new fact is added, the system SHALL search for existing active facts that may conflict with it. The search SHALL use embedding similarity with a threshold of 0.85. Candidates above the threshold SHALL be classified using a lightweight LLM call into one of: `contradicts`, `extends`, `duplicate`, `unrelated`.

#### Scenario: New fact contradicts an existing fact with high confidence

- **WHEN** `add()` is called and the conflict classifier returns `contradicts` with confidence > 0.9 for an existing fact
- **THEN** the existing fact is automatically invalidated (`invalid_at` set to now, `superseded_by` set to the new fact's ID), and the new fact's `related` field includes the old fact's ID

#### Scenario: New fact contradicts an existing fact with low confidence

- **WHEN** `add()` is called and the conflict classifier returns `contradicts` with confidence <= 0.9 for an existing fact
- **THEN** the system adds the new fact without invalidating the old one, links them via `related`, and logs a warning about the potential conflict

#### Scenario: New fact extends an existing fact

- **WHEN** the conflict classifier returns `extends` for an existing fact
- **THEN** both facts remain active, and they are linked bidirectionally via `related`

#### Scenario: New fact is a duplicate

- **WHEN** the conflict classifier returns `duplicate` for an existing fact
- **THEN** the new fact is NOT created. The existing fact's `access_count` is incremented and `last_accessed` is updated. The system returns the existing fact.

#### Scenario: No embedding provider available

- **WHEN** `add()` is called but no embedding provider is configured or available
- **THEN** conflict detection is skipped, the fact is added without checking for conflicts, and a warning is logged

### Requirement: Fact invalidation with provenance

When a fact is invalidated, the system SHALL record the reason and the invalidating fact (if applicable). Invalidated facts SHALL remain on the filesystem — they are never deleted, only marked with `invalid_at` and optionally `invalidated_by`.

#### Scenario: Manual invalidation with reason

- **WHEN** `invalidate(factId, "Bug was fixed in PR #350")` is called
- **THEN** the fact's frontmatter is updated: `invalid_at` set to now, the reason is appended to the content body under a `## Invalidation` heading

#### Scenario: Automatic invalidation via conflict detection

- **WHEN** conflict detection auto-invalidates a fact due to a superseding fact
- **THEN** the old fact's `invalid_at` is set to now, `superseded_by` is set to the new fact's ID, and a `## Invalidation` section is appended with the reason "Superseded by {new-fact-id}"

### Requirement: Fact evolution

The `evolve()` operation SHALL update a fact's content without invalidating it. This is for cases where new information augments (not contradicts) the existing fact.

#### Scenario: Evolving a fact with new information

- **WHEN** `evolve(factId, "Additional detail: the cursor is base64-encoded")` is called
- **THEN** the fact's content body is updated to include the new information, `ingested_at` is updated to now, and a git commit records the change

#### Scenario: Attempting to evolve an invalidated fact

- **WHEN** `evolve()` is called on a fact where `invalid_at` is not null
- **THEN** the system returns an error indicating the fact is invalidated and cannot be evolved

### Requirement: Decay scoring

Each fact SHALL have a computed decay score based on the formula `decay_score = exp(-λ * days_since_last_access)` where λ varies by `decay_class`: `slow` = 0.003/day, `normal` = 0.015/day, `fast` = 0.05/day. The decay score is NOT stored in frontmatter — it is computed at query time from `last_accessed` and `decay_class`.

#### Scenario: Recently accessed slow-decay fact

- **WHEN** a fact with `decay_class: slow` was last accessed 10 days ago
- **THEN** its decay score is `exp(-0.003 * 10)` ≈ 0.97

#### Scenario: Old fast-decay fact

- **WHEN** a fact with `decay_class: fast` was last accessed 30 days ago
- **THEN** its decay score is `exp(-0.05 * 30)` ≈ 0.22

#### Scenario: Very old fast-decay fact below threshold

- **WHEN** a fact with `decay_class: fast` was last accessed 60 days ago
- **THEN** its decay score is `exp(-0.05 * 60)` ≈ 0.05, which is below the GC threshold of 0.1

### Requirement: Access tracking

When a fact is returned in a recall or search result, the system SHALL update its `access_count` (increment by 1) and `last_accessed` (set to now) in the frontmatter. These updates SHALL be batched and committed periodically (not on every single access) to avoid excessive git commits.

#### Scenario: Fact returned in recall

- **WHEN** a fact is included in the results of `recall()`
- **THEN** the fact's `access_count` is incremented and `last_accessed` is updated in memory, with the filesystem update batched

#### Scenario: Batched access tracking commit

- **WHEN** access tracking updates have accumulated for 5+ facts or 5+ minutes have passed since the last batch
- **THEN** all pending access tracking updates are written to their fact files and committed in a single git commit with message `memory(access): update access counts for N facts`
