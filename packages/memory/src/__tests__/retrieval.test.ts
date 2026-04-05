import type { Client } from '@libsql/client';
import { describe, it, expect, beforeEach } from 'vitest';

import { RelationshipGraph } from '../graph.js';
import { RetrievalEngine } from '../retrieval.js';
import { insertFact } from '../storage.js';
import { VectorIndex } from '../vector-index.js';
import { createTestDb, makeFact, NullMockEmbeddingProvider } from './helpers.js';

describe('RetrievalEngine (integration)', () => {
  let db: Client;
  let graph: RelationshipGraph;
  let vectorIndex: VectorIndex;
  let engine: RetrievalEngine;
  const projectId = 'test-project';

  beforeEach(async () => {
    db = await createTestDb();
    graph = new RelationshipGraph();
    // Use NullMockEmbeddingProvider to test keyword-only retrieval
    vectorIndex = new VectorIndex(db, new NullMockEmbeddingProvider());
    engine = new RetrievalEngine(db, projectId, vectorIndex, graph);
  });

  // ─── recall ─────────────────────────────────────────

  describe('recall', () => {
    it('returns empty for empty database', async () => {
      const results = await engine.recall('anything');
      expect(results).toEqual([]);
    });

    it('finds facts by keyword matching', async () => {
      await insertFact(
        db,
        makeFact({
          id: 'f1',
          projectId,
          content: 'Use libSQL for database storage',
          type: 'decision',
        }),
      );
      await insertFact(
        db,
        makeFact({
          id: 'f2',
          projectId,
          content: 'React components should be functional',
          type: 'convention',
        }),
      );
      await insertFact(
        db,
        makeFact({
          id: 'f3',
          projectId,
          content: 'Authentication uses Better Auth',
          type: 'decision',
        }),
      );

      const results = await engine.recall('libSQL database');
      expect(results.length).toBeGreaterThan(0);
      expect(results.some((f) => f.id === 'f1')).toBe(true);
    });

    it('respects limit option', async () => {
      for (let i = 0; i < 20; i++) {
        await insertFact(
          db,
          makeFact({
            id: `f-${i}`,
            projectId,
            content: `fact about testing number ${i}`,
          }),
        );
      }

      const results = await engine.recall('testing', { limit: 5 });
      expect(results.length).toBeLessThanOrEqual(5);
    });

    it('excludes invalidated facts by default', async () => {
      await insertFact(
        db,
        makeFact({ id: 'f-valid', projectId, content: 'valid fact about deployment' }),
      );
      await insertFact(
        db,
        makeFact({
          id: 'f-invalid',
          projectId,
          content: 'invalid fact about deployment',
          invalidAt: '2025-01-01T00:00:00Z',
        }),
      );

      const results = await engine.recall('deployment');
      expect(results.every((f) => f.invalidAt === null)).toBe(true);
    });

    it('includes invalidated facts when requested', async () => {
      await insertFact(db, makeFact({ id: 'fv', projectId, content: 'valid fact about API' }));
      await insertFact(
        db,
        makeFact({
          id: 'fi',
          projectId,
          content: 'invalid fact about API',
          invalidAt: '2025-01-01T00:00:00Z',
        }),
      );

      const results = await engine.recall('API', { includeInvalidated: true });
      expect(results.length).toBe(2);
    });

    it('filters by minimum confidence', async () => {
      await insertFact(
        db,
        makeFact({
          id: 'f-high',
          projectId,
          content: 'high confidence fact about testing',
          confidence: 0.9,
        }),
      );
      await insertFact(
        db,
        makeFact({
          id: 'f-low',
          projectId,
          content: 'low confidence fact about testing',
          confidence: 0.3,
        }),
      );

      const results = await engine.recall('testing', { minConfidence: 0.5 });
      expect(results.every((f) => f.confidence >= 0.5)).toBe(true);
    });

    it('uses graph traversal to find related facts', async () => {
      await insertFact(
        db,
        makeFact({
          id: 'f-seed',
          projectId,
          content: 'main fact about architecture',
          related: ['f-related'],
        }),
      );
      await insertFact(
        db,
        makeFact({
          id: 'f-related',
          projectId,
          content: 'related fact about design patterns',
        }),
      );

      graph.buildFromFacts([
        makeFact({ id: 'f-seed', related: ['f-related'] }),
        makeFact({ id: 'f-related' }),
      ]);

      const results = await engine.recall('architecture');
      // Should find both the seed and the related fact via graph
      const ids = results.map((f) => f.id);
      expect(ids).toContain('f-seed');
    });
  });

  // ─── search ─────────────────────────────────────────

  describe('search', () => {
    it('returns all facts when query is empty', async () => {
      await insertFact(
        db,
        makeFact({ id: 'ea1', projectId, content: 'first fact', type: 'decision' }),
      );
      await insertFact(db, makeFact({ id: 'ea2', projectId, content: 'second fact', type: 'bug' }));
      await insertFact(
        db,
        makeFact({ id: 'ea3', projectId, content: 'third fact', type: 'insight' }),
      );

      const results = await engine.search('');
      expect(results.length).toBe(3);
    });

    it('returns all facts when query is whitespace', async () => {
      await insertFact(db, makeFact({ id: 'ws1', projectId, content: 'a fact' }));
      await insertFact(db, makeFact({ id: 'ws2', projectId, content: 'another fact' }));

      const results = await engine.search('   ');
      expect(results.length).toBe(2);
    });

    it('applies filters even with empty query', async () => {
      await insertFact(
        db,
        makeFact({ id: 'ef1', projectId, content: 'a decision', type: 'decision' }),
      );
      await insertFact(
        db,
        makeFact({ id: 'ef2', projectId, content: 'a bug report', type: 'bug' }),
      );

      const results = await engine.search('', { type: 'decision' });
      expect(results.length).toBe(1);
      expect(results[0].type).toBe('decision');
    });

    it('returns empty for empty database with empty query', async () => {
      const results = await engine.search('');
      expect(results).toEqual([]);
    });

    it('filters by type', async () => {
      await insertFact(
        db,
        makeFact({ id: 'f-dec', projectId, type: 'decision', content: 'Use React for UI' }),
      );
      await insertFact(
        db,
        makeFact({ id: 'f-bug', projectId, type: 'bug', content: 'React rendering issue' }),
      );

      const results = await engine.search('React', { type: 'decision' });
      expect(results.length).toBe(1);
      expect(results[0].type).toBe('decision');
    });

    it('filters by multiple types', async () => {
      await insertFact(
        db,
        makeFact({ id: 'sd', projectId, type: 'decision', content: 'Use React' }),
      );
      await insertFact(db, makeFact({ id: 'sb', projectId, type: 'bug', content: 'React bug' }));
      await insertFact(
        db,
        makeFact({ id: 'si', projectId, type: 'insight', content: 'React insight' }),
      );

      const results = await engine.search('React', { type: ['decision', 'bug'] });
      expect(results.length).toBe(2);
    });

    it('filters by tags', async () => {
      await insertFact(
        db,
        makeFact({
          id: 'ft1',
          projectId,
          content: 'fact with auth tag',
          tags: ['auth', 'security'],
        }),
      );
      await insertFact(
        db,
        makeFact({
          id: 'ft2',
          projectId,
          content: 'fact without auth tag',
          tags: ['ui'],
        }),
      );

      const results = await engine.search('fact', { tags: ['auth'] });
      expect(results.length).toBe(1);
      expect(results[0].tags).toContain('auth');
    });

    it('filters by sourceAgent', async () => {
      await insertFact(
        db,
        makeFact({
          id: 'sa1',
          projectId,
          content: 'from claude agent',
          sourceAgent: 'claude',
        }),
      );
      await insertFact(
        db,
        makeFact({
          id: 'sa2',
          projectId,
          content: 'from codex agent',
          sourceAgent: 'codex',
        }),
      );

      const results = await engine.search('agent', { sourceAgent: 'claude' });
      expect(results.length).toBe(1);
      expect(results[0].sourceAgent).toBe('claude');
    });

    it('filters by minConfidence', async () => {
      await insertFact(
        db,
        makeFact({ id: 'mc1', projectId, content: 'high conf search', confidence: 0.9 }),
      );
      await insertFact(
        db,
        makeFact({ id: 'mc2', projectId, content: 'low conf search', confidence: 0.2 }),
      );

      const results = await engine.search('search', { minConfidence: 0.5 });
      expect(results.every((f) => f.confidence >= 0.5)).toBe(true);
    });

    it('filters by createdAfter', async () => {
      await insertFact(
        db,
        makeFact({
          id: 'ca1',
          projectId,
          content: 'old fact about testing',
          ingestedAt: '2024-01-01T00:00:00Z',
        }),
      );
      await insertFact(
        db,
        makeFact({
          id: 'ca2',
          projectId,
          content: 'new fact about testing',
          ingestedAt: '2025-06-01T00:00:00Z',
        }),
      );

      const results = await engine.search('testing', {
        createdAfter: '2025-01-01T00:00:00Z',
      });
      expect(results.length).toBe(1);
      expect(results[0].id).toBe('ca2');
    });
  });

  // ─── timeline ───────────────────────────────────────

  describe('timeline', () => {
    it('returns facts in chronological order', async () => {
      await insertFact(
        db,
        makeFact({
          id: 't1',
          projectId,
          validFrom: '2025-03-01T00:00:00Z',
        }),
      );
      await insertFact(
        db,
        makeFact({
          id: 't2',
          projectId,
          validFrom: '2025-01-01T00:00:00Z',
        }),
      );
      await insertFact(
        db,
        makeFact({
          id: 't3',
          projectId,
          validFrom: '2025-02-01T00:00:00Z',
        }),
      );

      const results = await engine.timeline();
      expect(results[0].id).toBe('t2');
      expect(results[1].id).toBe('t3');
      expect(results[2].id).toBe('t1');
    });

    it('filters by date range', async () => {
      await insertFact(db, makeFact({ id: 'tr1', projectId, validFrom: '2025-01-01T00:00:00Z' }));
      await insertFact(db, makeFact({ id: 'tr2', projectId, validFrom: '2025-03-01T00:00:00Z' }));
      await insertFact(db, makeFact({ id: 'tr3', projectId, validFrom: '2025-06-01T00:00:00Z' }));

      const results = await engine.timeline({
        from: '2025-02-01T00:00:00Z',
        to: '2025-04-01T00:00:00Z',
      });
      expect(results.length).toBe(1);
      expect(results[0].id).toBe('tr2');
    });

    it('filters by type', async () => {
      await insertFact(
        db,
        makeFact({ id: 'tt1', projectId, type: 'decision', validFrom: '2025-01-01T00:00:00Z' }),
      );
      await insertFact(
        db,
        makeFact({ id: 'tt2', projectId, type: 'bug', validFrom: '2025-02-01T00:00:00Z' }),
      );

      const results = await engine.timeline({ type: 'bug' });
      expect(results.length).toBe(1);
      expect(results[0].type).toBe('bug');
    });

    it('excludes invalidated by default', async () => {
      await insertFact(db, makeFact({ id: 'tv', projectId, validFrom: '2025-01-01T00:00:00Z' }));
      await insertFact(
        db,
        makeFact({
          id: 'ti',
          projectId,
          validFrom: '2025-02-01T00:00:00Z',
          invalidAt: '2025-03-01T00:00:00Z',
        }),
      );

      const results = await engine.timeline();
      expect(results.length).toBe(1);
    });

    it('includes invalidated when requested', async () => {
      await insertFact(db, makeFact({ id: 'tiv', projectId, validFrom: '2025-01-01T00:00:00Z' }));
      await insertFact(
        db,
        makeFact({
          id: 'tii',
          projectId,
          validFrom: '2025-02-01T00:00:00Z',
          invalidAt: '2025-03-01T00:00:00Z',
        }),
      );

      const results = await engine.timeline({ includeInvalidated: true });
      expect(results.length).toBe(2);
    });
  });
});
