/**
 * @domain subdomain: Memory System (Paisley Park)
 * @domain subdomain-type: core
 * @domain type: domain-service
 * @domain layer: domain
 *
 * Temporal engine: bi-temporal tracking, decay scoring, conflict detection,
 * fact invalidation and evolution.
 */

import type { MemoryFact } from '@funny/shared';

import type {
  ConflictResult,
  ConflictRelation,
  EmbeddingProvider,
  MemoryFactFile,
  MemoryFactFrontmatter,
} from './types.js';
import { DECAY_LAMBDAS, DEFAULT_DECAY_CLASS } from './types.js';

// ─── Decay scoring ──────────────────────────────────────

/**
 * Calculate the decay score for a fact.
 * Formula: exp(-λ * days_since_last_access)
 * Returns a value between 0 (fully decayed) and 1 (just accessed).
 */
export function calculateDecayScore(fact: MemoryFactFrontmatter, now: Date = new Date()): number {
  const lastAccess = new Date(fact.last_accessed);
  const daysSinceAccess = (now.getTime() - lastAccess.getTime()) / 86_400_000;
  const lambda = DECAY_LAMBDAS[fact.decay_class];
  return Math.exp(-lambda * daysSinceAccess);
}

/**
 * Infer the default decay class from a fact type.
 */
export function inferDecayClass(type: string): 'slow' | 'normal' | 'fast' {
  return DEFAULT_DECAY_CLASS[type as keyof typeof DEFAULT_DECAY_CLASS] ?? 'normal';
}

// ─── Bi-temporal queries ────────────────────────────────

/**
 * Check if a fact was valid at a given point in time.
 * Uses the valid_from/invalid_at (assertion time) window.
 */
export function wasValidAt(fact: MemoryFactFrontmatter, asOf: Date): boolean {
  const validFrom = new Date(fact.valid_from);
  if (asOf < validFrom) return false;

  if (fact.invalid_at !== null) {
    const invalidAt = new Date(fact.invalid_at);
    if (asOf >= invalidAt) return false;
  }

  return true;
}

/**
 * Check if a fact is currently valid (not invalidated).
 */
export function isCurrentlyValid(fact: MemoryFactFrontmatter): boolean {
  return fact.invalid_at === null;
}

// ─── Invalidation ───────────────────────────────────────

/**
 * Produce updated frontmatter for invalidating a fact.
 */
export function invalidateFact(
  fact: MemoryFactFrontmatter,
  reason?: string,
  supersededById?: string,
): MemoryFactFrontmatter {
  return {
    ...fact,
    invalid_at: new Date().toISOString(),
    invalidated_by: reason ?? null,
    superseded_by: supersededById ?? null,
  };
}

// ─── Evolution ──────────────────────────────────────────

/**
 * Check if a fact can be evolved (must not be invalidated).
 */
export function canEvolve(fact: MemoryFactFrontmatter): boolean {
  return fact.invalid_at === null;
}

/**
 * Produce updated frontmatter for an evolved fact.
 * Updates ingested_at to now (new knowledge time).
 */
export function evolveFact(fact: MemoryFactFrontmatter): MemoryFactFrontmatter {
  return {
    ...fact,
    ingested_at: new Date().toISOString(),
  };
}

// ─── Access tracking ────────────────────────────────────

/**
 * In-memory buffer for access tracking updates.
 * Flushes to disk after FLUSH_THRESHOLD facts or FLUSH_INTERVAL_MS.
 */
export class AccessTracker {
  private pending = new Map<string, { count: number; lastAccessed: string }>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly flushCallback: (
      updates: Map<string, { count: number; lastAccessed: string }>,
    ) => Promise<void>,
    private readonly flushThreshold: number = 5,
    private readonly flushIntervalMs: number = 5 * 60_000, // 5 minutes
  ) {}

  track(factId: string) {
    const existing = this.pending.get(factId);
    const now = new Date().toISOString();
    if (existing) {
      existing.count++;
      existing.lastAccessed = now;
    } else {
      this.pending.set(factId, { count: 1, lastAccessed: now });
    }

    if (this.pending.size >= this.flushThreshold) {
      void this.flush();
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => void this.flush(), this.flushIntervalMs);
    }
  }

  async flush() {
    if (this.pending.size === 0) return;

    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    const updates = new Map(this.pending);
    this.pending.clear();
    await this.flushCallback(updates);
  }

  destroy() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }
}

// ─── Conflict detection ─────────────────────────────────

/**
 * Find potential conflicts between a new fact and existing facts.
 * Uses embedding similarity as a first-pass filter.
 *
 * Returns facts with similarity > threshold for further analysis.
 */
export async function findPotentialConflicts(
  newContent: string,
  existingFacts: MemoryFactFile[],
  embeddingProvider: EmbeddingProvider | null,
  similarityThreshold: number = 0.85,
): Promise<ConflictResult[]> {
  if (!embeddingProvider || existingFacts.length === 0) return [];

  try {
    const newEmbedding = await embeddingProvider.embed(newContent);
    const existingContents = existingFacts.map((f) => f.content);
    const existingEmbeddings = await embeddingProvider.embedBatch(existingContents);

    const results: ConflictResult[] = [];
    for (let i = 0; i < existingFacts.length; i++) {
      const similarity = cosineSimilarity(newEmbedding, existingEmbeddings[i]);
      if (similarity >= similarityThreshold) {
        // High similarity — classify the relationship
        const relation = classifyRelation(similarity);
        results.push({
          existingFactId: existingFacts[i].frontmatter.id,
          relation,
          confidence: similarity,
        });
      }
    }

    return results.sort((a, b) => b.confidence - a.confidence);
  } catch (e) {
    // If embedding fails, return empty — don't block the write
    return [];
  }
}

/**
 * Simple heuristic for classifying the relationship based on similarity.
 * In Phase 3+, this would use an LLM for more accurate classification.
 */
function classifyRelation(similarity: number): ConflictRelation {
  if (similarity >= 0.98) return 'duplicate';
  if (similarity >= 0.92) return 'contradicts'; // Could be contradiction or extension
  return 'extends';
}

// ─── Cosine similarity ──────────────────────────────────

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dotProduct / denom;
}
