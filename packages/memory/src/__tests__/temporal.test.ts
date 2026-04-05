import { describe, it, expect } from 'vitest';

import {
  calculateDecayScore,
  inferDecayClass,
  wasValidAt,
  isCurrentlyValid,
  invalidateFact,
  canEvolve,
  evolveFact,
  cosineSimilarity,
  findPotentialConflicts,
  AccessTracker,
} from '../temporal.js';
import { makeFact, MockEmbeddingProvider } from './helpers.js';

describe('temporal', () => {
  // ─── Decay scoring ──────────────────────────────────

  describe('calculateDecayScore', () => {
    it('returns 1.0 for a fact accessed right now', () => {
      const now = new Date();
      const fact = makeFact({ lastAccessed: now.toISOString(), decayClass: 'normal' });
      const score = calculateDecayScore(fact, now);
      expect(score).toBeCloseTo(1.0, 5);
    });

    it('decreases over time', () => {
      const now = new Date();
      const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
      const fact = makeFact({ lastAccessed: weekAgo.toISOString(), decayClass: 'normal' });
      const score = calculateDecayScore(fact, now);
      expect(score).toBeLessThan(1.0);
      expect(score).toBeGreaterThan(0);
    });

    it('fast decay class decays faster than slow', () => {
      const now = new Date();
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 86_400_000);

      const fastFact = makeFact({ lastAccessed: thirtyDaysAgo.toISOString(), decayClass: 'fast' });
      const slowFact = makeFact({ lastAccessed: thirtyDaysAgo.toISOString(), decayClass: 'slow' });

      const fastScore = calculateDecayScore(fastFact, now);
      const slowScore = calculateDecayScore(slowFact, now);

      expect(fastScore).toBeLessThan(slowScore);
    });

    it('slow decay retains most value after 30 days', () => {
      const now = new Date();
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 86_400_000);
      const fact = makeFact({ lastAccessed: thirtyDaysAgo.toISOString(), decayClass: 'slow' });
      const score = calculateDecayScore(fact, now);
      // λ=0.003, 30 days → exp(-0.09) ≈ 0.914
      expect(score).toBeGreaterThan(0.9);
    });

    it('fast decay is very low after 90 days', () => {
      const now = new Date();
      const ninetyDaysAgo = new Date(now.getTime() - 90 * 86_400_000);
      const fact = makeFact({ lastAccessed: ninetyDaysAgo.toISOString(), decayClass: 'fast' });
      const score = calculateDecayScore(fact, now);
      // λ=0.05, 90 days → exp(-4.5) ≈ 0.011
      expect(score).toBeLessThan(0.02);
    });
  });

  // ─── Decay class inference ──────────────────────────

  describe('inferDecayClass', () => {
    it('maps known fact types', () => {
      expect(inferDecayClass('decision')).toBe('slow');
      expect(inferDecayClass('bug')).toBe('normal');
      expect(inferDecayClass('context')).toBe('fast');
    });

    it('defaults to normal for unknown types', () => {
      expect(inferDecayClass('unknown-type')).toBe('normal');
    });
  });

  // ─── Bi-temporal queries ────────────────────────────

  describe('wasValidAt', () => {
    it('returns true within valid window', () => {
      const fact = makeFact({
        validFrom: '2025-01-01T00:00:00Z',
        invalidAt: '2025-06-01T00:00:00Z',
      });
      expect(wasValidAt(fact, new Date('2025-03-15T00:00:00Z'))).toBe(true);
    });

    it('returns false before validFrom', () => {
      const fact = makeFact({ validFrom: '2025-01-01T00:00:00Z' });
      expect(wasValidAt(fact, new Date('2024-12-31T00:00:00Z'))).toBe(false);
    });

    it('returns false after invalidAt', () => {
      const fact = makeFact({
        validFrom: '2025-01-01T00:00:00Z',
        invalidAt: '2025-06-01T00:00:00Z',
      });
      expect(wasValidAt(fact, new Date('2025-07-01T00:00:00Z'))).toBe(false);
    });

    it('returns true when no invalidAt (still valid)', () => {
      const fact = makeFact({
        validFrom: '2025-01-01T00:00:00Z',
        invalidAt: null,
      });
      expect(wasValidAt(fact, new Date('2099-01-01T00:00:00Z'))).toBe(true);
    });
  });

  describe('isCurrentlyValid', () => {
    it('returns true when invalidAt is null', () => {
      expect(isCurrentlyValid(makeFact({ invalidAt: null }))).toBe(true);
    });

    it('returns false when invalidAt is set', () => {
      expect(isCurrentlyValid(makeFact({ invalidAt: '2025-01-01T00:00:00Z' }))).toBe(false);
    });
  });

  // ─── Invalidation ──────────────────────────────────

  describe('invalidateFact', () => {
    it('produces update fields with invalidAt set', () => {
      const fact = makeFact();
      const updates = invalidateFact(fact, 'outdated');
      expect(updates.invalidAt).toBeDefined();
      expect(updates.invalidatedBy).toBe('outdated');
      expect(updates.supersededBy).toBeNull();
    });

    it('includes supersededBy when provided', () => {
      const fact = makeFact();
      const updates = invalidateFact(fact, 'replaced', 'fact-new-123');
      expect(updates.supersededBy).toBe('fact-new-123');
    });

    it('handles no reason', () => {
      const fact = makeFact();
      const updates = invalidateFact(fact);
      expect(updates.invalidatedBy).toBeNull();
    });
  });

  // ─── Evolution ──────────────────────────────────────

  describe('canEvolve', () => {
    it('returns true for valid facts', () => {
      expect(canEvolve(makeFact({ invalidAt: null }))).toBe(true);
    });

    it('returns false for invalidated facts', () => {
      expect(canEvolve(makeFact({ invalidAt: '2025-01-01T00:00:00Z' }))).toBe(false);
    });
  });

  describe('evolveFact', () => {
    it('returns updated ingestedAt', () => {
      const fact = makeFact();
      const updates = evolveFact(fact);
      expect(updates.ingestedAt).toBeDefined();
      // Should be approximately now
      const diff = Math.abs(Date.now() - new Date(updates.ingestedAt!).getTime());
      expect(diff).toBeLessThan(1000);
    });
  });

  // ─── Cosine similarity ─────────────────────────────

  describe('cosineSimilarity', () => {
    it('returns 1.0 for identical vectors', () => {
      const v = new Float32Array([1, 2, 3]);
      expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 5);
    });

    it('returns 0 for orthogonal vectors', () => {
      const a = new Float32Array([1, 0, 0]);
      const b = new Float32Array([0, 1, 0]);
      expect(cosineSimilarity(a, b)).toBeCloseTo(0, 5);
    });

    it('returns -1 for opposite vectors', () => {
      const a = new Float32Array([1, 0, 0]);
      const b = new Float32Array([-1, 0, 0]);
      expect(cosineSimilarity(a, b)).toBeCloseTo(-1, 5);
    });

    it('returns 0 for different-length vectors', () => {
      const a = new Float32Array([1, 2]);
      const b = new Float32Array([1, 2, 3]);
      expect(cosineSimilarity(a, b)).toBe(0);
    });

    it('returns 0 for zero vectors', () => {
      const a = new Float32Array([0, 0, 0]);
      const b = new Float32Array([1, 2, 3]);
      expect(cosineSimilarity(a, b)).toBe(0);
    });
  });

  // ─── Conflict detection ─────────────────────────────

  describe('findPotentialConflicts', () => {
    it('returns empty when no embedding provider', async () => {
      const facts = [makeFact({ content: 'hello' })];
      const result = await findPotentialConflicts('hello', facts, null);
      expect(result).toEqual([]);
    });

    it('returns empty when no existing facts', async () => {
      const provider = new MockEmbeddingProvider();
      const result = await findPotentialConflicts('hello', [], provider);
      expect(result).toEqual([]);
    });

    it('detects similar content', async () => {
      const provider = new MockEmbeddingProvider();
      const existing = [makeFact({ content: 'Use libSQL for database storage' })];
      // Same content should produce high similarity
      const result = await findPotentialConflicts(
        'Use libSQL for database storage',
        existing,
        provider,
        0.5,
      );
      expect(result.length).toBeGreaterThan(0);
      expect(result[0].confidence).toBeGreaterThan(0.5);
    });

    it('results are sorted by confidence descending', async () => {
      const provider = new MockEmbeddingProvider();
      const existing = [
        makeFact({ content: 'Use libSQL for database storage' }),
        makeFact({ content: 'Use libSQL for database storage exactly' }),
      ];
      const result = await findPotentialConflicts(
        'Use libSQL for database storage',
        existing,
        provider,
        0.5,
      );
      if (result.length >= 2) {
        expect(result[0].confidence).toBeGreaterThanOrEqual(result[1].confidence);
      }
    });
  });

  // ─── AccessTracker ──────────────────────────────────

  describe('AccessTracker', () => {
    it('batches access tracking and flushes', async () => {
      let flushed: Map<string, { count: number; lastAccessed: string }> | null = null;
      const tracker = new AccessTracker(async (updates) => {
        flushed = new Map(updates);
      }, 3); // flush after 3

      tracker.track('fact-1');
      tracker.track('fact-2');
      expect(flushed).toBeNull(); // not yet

      tracker.track('fact-3');
      // Should have triggered flush
      await new Promise((r) => setTimeout(r, 10));
      expect(flushed).not.toBeNull();
      expect(flushed!.size).toBe(3);

      tracker.destroy();
    });

    it('increments count for repeated access', async () => {
      let flushed: Map<string, { count: number; lastAccessed: string }> | null = null;
      const tracker = new AccessTracker(async (updates) => {
        flushed = new Map(updates);
      }, 5);

      tracker.track('fact-1');
      tracker.track('fact-1');
      tracker.track('fact-1');
      await tracker.flush();

      expect(flushed).not.toBeNull();
      expect(flushed!.get('fact-1')!.count).toBe(3);

      tracker.destroy();
    });

    it('manual flush clears pending', async () => {
      let flushCount = 0;
      const tracker = new AccessTracker(async () => {
        flushCount++;
      }, 100);

      tracker.track('fact-1');
      await tracker.flush();
      expect(flushCount).toBe(1);

      // Second flush should be no-op (empty pending)
      await tracker.flush();
      expect(flushCount).toBe(1);

      tracker.destroy();
    });
  });
});
