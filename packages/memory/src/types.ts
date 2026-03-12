/**
 * @domain subdomain: Memory System (Paisley Park)
 * @domain type: internal-types
 * @domain layer: domain
 */

import type { DecayClass, FactType, MemoryScope } from '@funny/shared';

// ─── Frontmatter as stored on disk ──────────────────────

export interface MemoryFactFrontmatter {
  id: string;
  type: FactType;
  confidence: number;
  source_agent: string | null;
  source_operator: string | null;
  source_session: string | null;
  valid_from: string; // ISO 8601
  invalid_at: string | null;
  ingested_at: string; // ISO 8601
  invalidated_by: string | null;
  superseded_by: string | null;
  tags: string[];
  related: string[];
  decay_class: DecayClass;
  access_count: number;
  last_accessed: string; // ISO 8601
}

// ─── Parsed fact (frontmatter + content) ────────────────

export interface MemoryFactFile {
  frontmatter: MemoryFactFrontmatter;
  content: string;
  /** Relative path within the memory directory (e.g. project/facts/my-fact.md) */
  relativePath: string;
}

// ─── Storage configuration ──────────────────────────────

export interface StorageConfig {
  /** Root directory for this project's memory (e.g. ~/.funny/memory/<project-id>/) */
  memoryDir: string;
  /** Project ID this memory belongs to */
  projectId: string;
  /** Project name (used for git commit messages) */
  projectName: string;
}

// ─── Write lock ─────────────────────────────────────────

export interface WriteLock {
  acquire(): Promise<void>;
  release(): void;
  readonly held: boolean;
}

// ─── Embedding provider ─────────────────────────────────

export interface EmbeddingProvider {
  embed(text: string): Promise<Float32Array>;
  embedBatch(texts: string[]): Promise<Float32Array[]>;
  dimensions(): number;
  modelId(): string;
}

// ─── Decay constants ────────────────────────────────────

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

// ─── Frontmatter ↔ API type conversion ──────────────────

export function frontmatterToApi(fm: MemoryFactFrontmatter, content: string) {
  return {
    id: fm.id,
    type: fm.type,
    confidence: fm.confidence,
    sourceAgent: fm.source_agent,
    sourceOperator: fm.source_operator,
    sourceSession: fm.source_session,
    validFrom: fm.valid_from,
    invalidAt: fm.invalid_at,
    ingestedAt: fm.ingested_at,
    invalidatedBy: fm.invalidated_by,
    supersededBy: fm.superseded_by,
    tags: fm.tags,
    related: fm.related,
    decayClass: fm.decay_class,
    accessCount: fm.access_count,
    lastAccessed: fm.last_accessed,
    content,
  };
}

// ─── Conflict detection result ──────────────────────────

export type ConflictRelation = 'contradicts' | 'extends' | 'duplicate' | 'unrelated';

export interface ConflictResult {
  existingFactId: string;
  relation: ConflictRelation;
  confidence: number;
}

// ─── Recall context for formatting ──────────────────────

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

// ─── GC config ──────────────────────────────────────────

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

// ─── Memory scope → directory mapping ───────────────────

export function scopeToDir(scope: MemoryScope): string {
  switch (scope) {
    case 'project':
      return 'project/facts';
    case 'operator':
      return 'operators';
    case 'team':
      return 'team';
    case 'all':
      return 'project/facts';
  }
}
