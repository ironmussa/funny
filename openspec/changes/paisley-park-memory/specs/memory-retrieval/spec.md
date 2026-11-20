## ADDED Requirements

### Requirement: Embedding search

The retrieval engine SHALL support semantic search via vector embeddings. Each fact's content SHALL be embedded using a configurable `EmbeddingProvider` and stored in a SQLite-vec index at `~/.funny/memory/{project-id}/.index/vectors.db`. The search SHALL return facts ranked by cosine similarity.

#### Scenario: Semantic search with embeddings available

- **WHEN** `recall("rate limiting for the API")` is called and an embedding provider is configured
- **THEN** the system embeds the query, searches the vector index for the top-K nearest facts by cosine similarity, and returns them as candidates for ranking

#### Scenario: New fact is embedded on creation

- **WHEN** a new fact is created via `add()` and an embedding provider is configured
- **THEN** the fact's content is embedded and the vector is stored in the SQLite-vec index alongside the fact ID

#### Scenario: Embedding provider unavailable

- **WHEN** a search is performed but no embedding provider is configured or Ollama is not running
- **THEN** the system falls back to keyword-only search and logs a warning — it does NOT fail the recall

### Requirement: Keyword/BM25 search

The retrieval engine SHALL support keyword-based search on fact content and tags. This search SHALL work independently of embeddings and serve as a fallback when embeddings are unavailable.

#### Scenario: Keyword search by tags

- **WHEN** `search(query, { tags: ["redis", "cluster"] })` is called
- **THEN** the system returns all active facts whose `tags` array contains all specified tags, ranked by relevance to the query text

#### Scenario: Full-text keyword search

- **WHEN** `search("cursor pagination")` is called without tag filters
- **THEN** the system searches fact content and tags for the terms "cursor" and "pagination", scoring by term frequency and returning ranked results

#### Scenario: Combined embedding + keyword search

- **WHEN** `recall()` is called with both embeddings and keyword search available
- **THEN** the system runs both searches, merges results with weighted scoring (embedding similarity weight + keyword relevance weight), and deduplicates

### Requirement: Graph traversal of related facts

The retrieval engine SHALL maintain an in-memory graph of fact relationships built from the `related` field in frontmatter. Given seed facts from embedding/keyword search, the engine SHALL traverse the graph to find contextually related facts up to 2 hops deep.

#### Scenario: Graph traversal from search results

- **WHEN** embedding search returns fact-A, and fact-A's `related` field includes [fact-B, fact-C], and fact-B's `related` includes [fact-D]
- **THEN** the graph traversal returns fact-B, fact-C, and fact-D as additional candidates (up to 2 hops from seed facts)

#### Scenario: Graph rebuild on startup

- **WHEN** the memory service starts or the graph is not yet built
- **THEN** the system reads all fact files in `project/facts/`, extracts `related` fields from frontmatter, and builds an in-memory adjacency map (`Map<string, Set<string>>`)

#### Scenario: Graph update on fact creation

- **WHEN** a new fact is created with `relatedTo: ["fact-2026-03-08-b2c1"]`
- **THEN** the in-memory graph is updated to include the bidirectional relationship — both the new fact and the referenced fact's adjacency sets are updated

### Requirement: Ranking engine

The ranking engine SHALL combine results from all search strategies (embedding, keyword, graph) and produce a final ranked list. Ranking SHALL consider: temporal validity (filter out invalidated facts), decay score, and search relevance score. The engine SHALL deduplicate facts that appear in multiple search results.

#### Scenario: Ranking with temporal filter

- **WHEN** ranking engine receives candidates and `includeInvalidated` is false (default)
- **THEN** all facts with `invalid_at != null` AND `invalid_at <= now` are removed from candidates before ranking

#### Scenario: Ranking with decay scoring

- **WHEN** ranking engine scores candidates
- **THEN** each candidate's final score is `relevance_score * decay_score`, where `relevance_score` comes from embedding similarity or keyword match, and `decay_score` is computed from `last_accessed` and `decay_class`

#### Scenario: Deduplication

- **WHEN** the same fact appears in both embedding results and keyword results
- **THEN** the fact appears only once in the final results, with the higher of the two relevance scores

#### Scenario: Result limit

- **WHEN** `recall()` is called with `limit: 5`
- **THEN** the ranking engine returns at most 5 facts, sorted by final score descending

### Requirement: Configurable embedding provider

The system SHALL define an `EmbeddingProvider` interface with at least two implementations: `OllamaEmbeddingProvider` (local, default) and `OpenAIEmbeddingProvider` (cloud, optional). The provider is selected via environment variables.

#### Scenario: Ollama provider configuration

- **WHEN** `MEMORY_EMBEDDING_PROVIDER=ollama` (or not set, as it's the default) and `MEMORY_OLLAMA_MODEL=nomic-embed-text`
- **THEN** the system uses Ollama's local API to generate embeddings with the specified model

#### Scenario: OpenAI provider configuration

- **WHEN** `MEMORY_EMBEDDING_PROVIDER=openai` and `OPENAI_API_KEY` is set
- **THEN** the system uses OpenAI's `text-embedding-3-small` model to generate embeddings

#### Scenario: No provider available

- **WHEN** no embedding provider is configured or the configured provider is unreachable
- **THEN** the system operates in keyword-only mode — all embedding-dependent features (semantic search, conflict detection similarity check) are gracefully degraded

### Requirement: Vector index management

The SQLite-vec index SHALL be stored at `~/.funny/memory/{project-id}/.index/vectors.db`. The `.index/` directory SHALL be gitignored. The index SHALL store a metadata file at `.index/meta.json` recording the embedding model identifier and dimensions.

#### Scenario: Index creation on first use

- **WHEN** the vector index is accessed for the first time
- **THEN** the system creates `.index/vectors.db` with a `vec_facts` virtual table and `.index/meta.json` with the current model configuration

#### Scenario: Model change detection

- **WHEN** the configured embedding model differs from the one recorded in `.index/meta.json`
- **THEN** the system drops the existing index, re-embeds all active facts, rebuilds the index, and updates `meta.json`

#### Scenario: Index rebuild from filesystem

- **WHEN** `.index/vectors.db` is missing but fact files exist
- **THEN** the system reads all active fact files, embeds their content, and creates a new vector index
