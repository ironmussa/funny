import type { Client } from '@libsql/client';
import { describe, it, expect, beforeEach } from 'vitest';

import { insertFact } from '../storage.js';
import { VectorIndex } from '../vector-index.js';
import {
  createTestDb,
  makeFact,
  MockEmbeddingProvider,
  NullMockEmbeddingProvider,
} from './helpers.js';

describe('VectorIndex', () => {
  let db: Client;
  let provider: MockEmbeddingProvider;
  let index: VectorIndex;

  beforeEach(async () => {
    db = await createTestDb();
    provider = new MockEmbeddingProvider(8);
    index = new VectorIndex(db, provider);
  });

  // ─── isAvailable ────────────────────────────────────

  describe('isAvailable', () => {
    it('returns true when provider has dimensions', () => {
      expect(index.isAvailable()).toBe(true);
    });

    it('returns false with null provider', () => {
      const nullIndex = new VectorIndex(db, new NullMockEmbeddingProvider());
      expect(nullIndex.isAvailable()).toBe(false);
    });
  });

  // ─── addVector / removeVector ───────────────────────

  describe('addVector', () => {
    it('adds a vector embedding', async () => {
      // Must insert fact first (FK constraint)
      await insertFact(db, makeFact({ id: 'fact-1' }));
      const result = await index.addVector('fact-1', 'Hello world');
      expect(result.isOk()).toBe(true);

      const count = await index.getFactCount();
      expect(count).toBe(1);
    });

    it('skips when provider has no dimensions', async () => {
      const nullIndex = new VectorIndex(db, new NullMockEmbeddingProvider());
      const result = await nullIndex.addVector('fact-1', 'Hello');
      expect(result.isOk()).toBe(true);

      const count = await nullIndex.getFactCount();
      expect(count).toBe(0);
    });
  });

  describe('removeVector', () => {
    it('removes an existing vector', async () => {
      await insertFact(db, makeFact({ id: 'fact-1' }));
      await index.addVector('fact-1', 'Hello world');
      await index.removeVector('fact-1');

      const count = await index.getFactCount();
      expect(count).toBe(0);
    });
  });

  // ─── searchSimilar ─────────────────────────────────

  describe('searchSimilar', () => {
    it('finds similar vectors', async () => {
      await insertFact(db, makeFact({ id: 'fact-1' }));
      await insertFact(db, makeFact({ id: 'fact-2' }));
      await insertFact(db, makeFact({ id: 'fact-3' }));
      await index.addVector('fact-1', 'libSQL database storage');
      await index.addVector('fact-2', 'libSQL database storage system');
      await index.addVector('fact-3', 'completely unrelated content about cooking');

      const result = await index.searchSimilar('libSQL database', 3);
      expect(result.isOk()).toBe(true);

      const results = result._unsafeUnwrap();
      expect(results.length).toBeGreaterThan(0);
      // First result should be more similar to the query
      expect(results[0].score).toBeGreaterThan(0);
    });

    it('respects topK limit', async () => {
      for (let i = 0; i < 10; i++) {
        await insertFact(db, makeFact({ id: `fact-${i}` }));
        await index.addVector(`fact-${i}`, `content ${i}`);
      }

      const result = await index.searchSimilar('content', 3);
      expect(result._unsafeUnwrap().length).toBeLessThanOrEqual(3);
    });

    it('returns empty with null provider', async () => {
      const nullIndex = new VectorIndex(db, new NullMockEmbeddingProvider());
      const result = await nullIndex.searchSimilar('query');
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toEqual([]);
    });

    it('returns results sorted by score descending', async () => {
      await insertFact(db, makeFact({ id: 'fact-1' }));
      await insertFact(db, makeFact({ id: 'fact-2' }));
      await insertFact(db, makeFact({ id: 'fact-3' }));
      await index.addVector('fact-1', 'libSQL');
      await index.addVector('fact-2', 'libSQL database');
      await index.addVector('fact-3', 'something else entirely different');

      const result = await index.searchSimilar('libSQL database', 3);
      const results = result._unsafeUnwrap();

      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
      }
    });
  });

  // ─── rebuild ────────────────────────────────────────

  describe('rebuild', () => {
    it('rebuilds index from facts', async () => {
      // Add some initial facts + vectors
      await insertFact(db, makeFact({ id: 'old-1' }));
      await index.addVector('old-1', 'old content');

      // Insert facts needed for rebuild
      await insertFact(db, makeFact({ id: 'new-1' }));
      await insertFact(db, makeFact({ id: 'new-2' }));

      const result = await index.rebuild([
        { id: 'new-1', content: 'new content 1' },
        { id: 'new-2', content: 'new content 2' },
      ]);

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBe(2);

      const count = await index.getFactCount();
      expect(count).toBe(2);
    });

    it('clears existing embeddings before rebuild', async () => {
      await insertFact(db, makeFact({ id: 'old-1' }));
      await insertFact(db, makeFact({ id: 'old-2' }));
      await index.addVector('old-1', 'old');
      await index.addVector('old-2', 'old');

      await insertFact(db, makeFact({ id: 'new-1' }));
      await index.rebuild([{ id: 'new-1', content: 'new' }]);

      const count = await index.getFactCount();
      expect(count).toBe(1);
    });

    it('returns 0 with null provider', async () => {
      const nullIndex = new VectorIndex(db, new NullMockEmbeddingProvider());
      const result = await nullIndex.rebuild([{ id: 'x', content: 'y' }]);
      expect(result._unsafeUnwrap()).toBe(0);
    });
  });

  // ─── needsRebuild ──────────────────────────────────

  describe('needsRebuild', () => {
    it('returns true when no model recorded', async () => {
      expect(await index.needsRebuild()).toBe(true);
    });

    it('returns false after rebuild with same provider', async () => {
      await insertFact(db, makeFact({ id: 'f1' }));
      await index.rebuild([{ id: 'f1', content: 'test' }]);
      expect(await index.needsRebuild()).toBe(false);
    });

    it('returns true when model changes', async () => {
      await insertFact(db, makeFact({ id: 'f1' }));
      await index.rebuild([{ id: 'f1', content: 'test' }]);

      // Create new index with different provider model
      const newProvider = new MockEmbeddingProvider(16);
      const newIndex = new VectorIndex(db, newProvider);
      // MockEmbeddingProvider returns 'mock:test' for both, so this won't trigger.
      // But if we store a different model name it would. Let's test with meta directly.
      const { setMeta } = await import('../storage.js');
      await setMeta(db, 'embedding_model', 'different:model');

      expect(await newIndex.needsRebuild()).toBe(true);
    });
  });

  // ─── getFactCount ───────────────────────────────────

  describe('getFactCount', () => {
    it('returns 0 for empty index', async () => {
      expect(await index.getFactCount()).toBe(0);
    });

    it('returns correct count', async () => {
      await insertFact(db, makeFact({ id: 'f1' }));
      await insertFact(db, makeFact({ id: 'f2' }));
      await index.addVector('f1', 'a');
      await index.addVector('f2', 'b');
      expect(await index.getFactCount()).toBe(2);
    });
  });
});
