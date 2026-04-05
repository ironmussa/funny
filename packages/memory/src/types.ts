/**
 * @domain subdomain: Memory System (Paisley Park)
 * @domain type: internal-types
 * @domain layer: domain
 *
 * All types are self-contained — no external dependencies.
 */

// ─── Core domain types ─────────────────────────────────

export type FactType = 'decision' | 'bug' | 'pattern' | 'convention' | 'insight' | 'context';

export type DecayClass = 'slow' | 'normal' | 'fast';

export type MemoryScope = 'project' | 'operator' | 'team' | 'all';

// ─── MemoryFact — the single canonical representation ──

export interface MemoryFact {
  id: string;
  type: FactType;
  confidence: number;
  sourceAgent: string | null;
  sourceOperator: string | null;
  sourceSession: string | null;
  validFrom: string; // ISO 8601
  invalidAt: string | null;
  ingestedAt: string; // ISO 8601
  invalidatedBy: string | null;
  supersededBy: string | null;
  tags: string[];
  related: string[];
  decayClass: DecayClass;
  accessCount: number;
  lastAccessed: string; // ISO 8601
  content: string;
  projectId: string;
}

// ─── API options ───────────────────────────────────────

export interface RecallOptions {
  limit?: number;
  scope?: MemoryScope;
  includeInvalidated?: boolean;
  minConfidence?: number;
  asOf?: string; // ISO 8601
  forOperator?: string;
}

export interface AddOptions {
  type: FactType;
  tags?: string[];
  confidence?: number;
  decayClass?: DecayClass;
  relatedTo?: string[];
  validFrom?: string; // ISO 8601
  scope?: MemoryScope;
  sourceAgent?: string;
  sourceOperator?: string;
  sourceSession?: string;
}

export interface SearchFilters {
  type?: FactType | FactType[];
  tags?: string[];
  sourceAgent?: string;
  validAt?: string; // ISO 8601
  createdAfter?: string; // ISO 8601
  createdBefore?: string; // ISO 8601
  minConfidence?: number;
}

export interface TimelineOptions {
  from?: string; // ISO 8601
  to?: string; // ISO 8601
  type?: FactType | FactType[];
  includeInvalidated?: boolean;
}

export interface MemoryRecallResult {
  facts: MemoryFact[];
  formattedContext: string;
  totalFound: number;
}

// ─── LLM configuration (for consolidation agent) ──────

export interface LLMConfig {
  /** api-acp base URL (e.g. http://localhost:4010) */
  baseUrl: string;
  /** Model ID (default: claude-haiku) */
  model?: string;
  /** Optional API key */
  apiKey?: string;
  /** Request timeout in ms (default: 60000) */
  timeoutMs?: number;
}

// ─── Storage configuration ─────────────────────────────

export interface StorageConfig {
  /** libSQL connection URL — file:path for local, libsql://host for remote */
  url: string;
  /** Optional sync URL for embedded replicas (sqld / Turso) */
  syncUrl?: string;
  /** Auth token for remote connections */
  authToken?: string;
  /** Sync interval in seconds for embedded replicas (default: 60) */
  syncInterval?: number;
  /** Project ID this memory belongs to */
  projectId: string;
  /** Project name for display */
  projectName: string;
  /** LLM config for consolidation agent (optional — without it, only mechanical GC runs) */
  llm?: LLMConfig;
}

// ─── Embedding provider ────────────────────────────────

export interface EmbeddingProvider {
  embed(text: string): Promise<Float32Array>;
  embedBatch(texts: string[]): Promise<Float32Array[]>;
  dimensions(): number;
  modelId(): string;
}

// ─── Decay constants ───────────────────────────────────

export const DECAY_LAMBDAS: Record<DecayClass, number> = {
  slow: 0.003,
  normal: 0.015,
  fast: 0.05,
};

/** Default decay class for each fact type */
export const DEFAULT_DECAY_CLASS: Record<FactType, DecayClass> = {
  decision: 'slow',
  bug: 'normal',
  pattern: 'slow',
  convention: 'slow',
  insight: 'normal',
  context: 'fast',
};

// ─── Conflict detection result ─────────────────────────

export type ConflictRelation = 'contradicts' | 'extends' | 'duplicate' | 'unrelated';

export interface ConflictResult {
  existingFactId: string;
  relation: ConflictRelation;
  confidence: number;
}

// ─── Operator / team profiles ──────────────────────────

export interface OperatorProfile {
  operator: string;
  role?: string;
  expertise?: string[];
  languages?: string[];
  preferences?: string[];
  notes?: string[];
}

export interface TeamRoster {
  members: Array<{
    operator: string;
    role: string;
    expertise: string[];
    modules: string[];
  }>;
}

// ─── GC config ─────────────────────────────────────────

export interface GCConfig {
  /** Minimum decay score to keep a fact active (below this → archive) */
  decayThreshold: number;
  /** Embedding similarity threshold for dedup */
  dedupThreshold: number;
  /** Embedding similarity threshold for consolidation */
  consolidationThreshold: number;
  /** Minimum cluster size for consolidation */
  consolidationMinCluster: number;
  /** Days of no access before fast-decay facts are orphaned */
  orphanDays: number;
  /** Max discrepancy ratio before index rebuild */
  indexRebuildThreshold: number;
}

export const DEFAULT_GC_CONFIG: GCConfig = {
  decayThreshold: 0.1,
  dedupThreshold: 0.95,
  consolidationThreshold: 0.8,
  consolidationMinCluster: 3,
  orphanDays: 90,
  indexRebuildThreshold: 0.2,
};

// ─── DB row type (internal — maps to SQL columns) ──────

export interface FactRow {
  id: string;
  type: string;
  content: string;
  confidence: number;
  source_agent: string | null;
  source_operator: string | null;
  source_session: string | null;
  valid_from: string;
  invalid_at: string | null;
  ingested_at: string;
  invalidated_by: string | null;
  superseded_by: string | null;
  tags: string; // JSON array
  related: string; // JSON array
  decay_class: string;
  access_count: number;
  last_accessed: string;
  project_id: string;
}

/** Convert a DB row to the public MemoryFact type */
export function rowToFact(row: FactRow): MemoryFact {
  return {
    id: row.id,
    type: row.type as FactType,
    confidence: row.confidence,
    sourceAgent: row.source_agent,
    sourceOperator: row.source_operator,
    sourceSession: row.source_session,
    validFrom: row.valid_from,
    invalidAt: row.invalid_at,
    ingestedAt: row.ingested_at,
    invalidatedBy: row.invalidated_by,
    supersededBy: row.superseded_by,
    tags: JSON.parse(row.tags || '[]'),
    related: JSON.parse(row.related || '[]'),
    decayClass: row.decay_class as DecayClass,
    accessCount: row.access_count,
    lastAccessed: row.last_accessed,
    content: row.content,
    projectId: row.project_id,
  };
}

/** Convert a MemoryFact to SQL parameter values */
export function factToParams(fact: MemoryFact) {
  return {
    id: fact.id,
    type: fact.type,
    content: fact.content,
    confidence: fact.confidence,
    source_agent: fact.sourceAgent,
    source_operator: fact.sourceOperator,
    source_session: fact.sourceSession,
    valid_from: fact.validFrom,
    invalid_at: fact.invalidAt,
    ingested_at: fact.ingestedAt,
    invalidated_by: fact.invalidatedBy,
    superseded_by: fact.supersededBy,
    tags: JSON.stringify(fact.tags),
    related: JSON.stringify(fact.related),
    decay_class: fact.decayClass,
    access_count: fact.accessCount,
    last_accessed: fact.lastAccessed,
    project_id: fact.projectId,
  };
}
