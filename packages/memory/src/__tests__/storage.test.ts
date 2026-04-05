import type { Client } from '@libsql/client';
import { describe, it, expect, beforeEach } from 'vitest';

import {
  createDb,
  initSchema,
  insertFact,
  getFact,
  updateFact,
  listFacts,
  deleteFact,
  upsertEmbedding,
  deleteEmbedding,
  getAllEmbeddings,
  getMeta,
  setMeta,
  generateFactId,
} from '../storage.js';
import { makeFact, createTestDb } from './helpers.js';

describe('storage', () => {
  let db: Client;

  beforeEach(async () => {
    db = await createTestDb();
  });

  // ─── Schema initialization ──────────────────────────

  describe('initSchema', () => {
    it('creates tables without error', async () => {
      // Already called in createTestDb, verify tables exist
      const result = await db.execute(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      );
      const tables = result.rows.map((r) => r.name);
      expect(tables).toContain('facts');
      expect(tables).toContain('fact_embeddings');
      expect(tables).toContain('meta');
    });

    it('is idempotent (can run twice)', async () => {
      const result = await initSchema(db);
      expect(result.isOk()).toBe(true);
    });
  });

  // ─── Fact CRUD ──────────────────────────────────────

  describe('insertFact', () => {
    it('inserts a fact successfully', async () => {
      const fact = makeFact({ projectId: 'proj-1' });
      const result = await insertFact(db, fact);
      expect(result.isOk()).toBe(true);
    });

    it('can upsert (INSERT OR REPLACE) with same ID', async () => {
      const fact = makeFact({ id: 'fact-same', projectId: 'proj-1' });
      await insertFact(db, fact);
      const updated = { ...fact, content: 'updated content' };
      const result = await insertFact(db, updated);
      expect(result.isOk()).toBe(true);

      const fetched = await getFact(db, 'fact-same');
      expect(fetched.isOk()).toBe(true);
      expect(fetched._unsafeUnwrap().content).toBe('updated content');
    });
  });

  describe('getFact', () => {
    it('retrieves an existing fact', async () => {
      const fact = makeFact({ id: 'fact-get-1', content: 'hello world' });
      await insertFact(db, fact);

      const result = await getFact(db, 'fact-get-1');
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().content).toBe('hello world');
      expect(result._unsafeUnwrap().id).toBe('fact-get-1');
    });

    it('returns error for non-existing fact', async () => {
      const result = await getFact(db, 'nonexistent');
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr()).toContain('not found');
    });

    it('correctly parses tags and related arrays', async () => {
      const fact = makeFact({
        id: 'fact-arrays',
        tags: ['tag1', 'tag2'],
        related: ['fact-other'],
      });
      await insertFact(db, fact);

      const result = await getFact(db, 'fact-arrays');
      expect(result._unsafeUnwrap().tags).toEqual(['tag1', 'tag2']);
      expect(result._unsafeUnwrap().related).toEqual(['fact-other']);
    });
  });

  describe('updateFact', () => {
    it('updates specific fields', async () => {
      const fact = makeFact({ id: 'fact-upd', confidence: 0.5 });
      await insertFact(db, fact);

      const result = await updateFact(db, 'fact-upd', { confidence: 0.95 });
      expect(result.isOk()).toBe(true);

      const fetched = await getFact(db, 'fact-upd');
      expect(fetched._unsafeUnwrap().confidence).toBe(0.95);
    });

    it('updates multiple fields at once', async () => {
      const fact = makeFact({ id: 'fact-multi-upd' });
      await insertFact(db, fact);

      await updateFact(db, 'fact-multi-upd', {
        invalid_at: '2025-06-01T00:00:00Z',
        invalidated_by: 'test-reason',
      });

      const fetched = await getFact(db, 'fact-multi-upd');
      expect(fetched._unsafeUnwrap().invalidAt).toBe('2025-06-01T00:00:00Z');
      expect(fetched._unsafeUnwrap().invalidatedBy).toBe('test-reason');
    });

    it('no-ops on empty updates', async () => {
      const result = await updateFact(db, 'fact-123', {});
      expect(result.isOk()).toBe(true);
    });
  });

  describe('listFacts', () => {
    it('lists facts by project', async () => {
      await insertFact(db, makeFact({ id: 'f1', projectId: 'proj-a' }));
      await insertFact(db, makeFact({ id: 'f2', projectId: 'proj-a' }));
      await insertFact(db, makeFact({ id: 'f3', projectId: 'proj-b' }));

      const result = await listFacts(db, 'proj-a');
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().length).toBe(2);
    });

    it('excludes invalidated facts by default', async () => {
      await insertFact(db, makeFact({ id: 'f-valid', projectId: 'proj-1', invalidAt: null }));
      await insertFact(
        db,
        makeFact({ id: 'f-invalid', projectId: 'proj-1', invalidAt: '2025-01-01T00:00:00Z' }),
      );

      const result = await listFacts(db, 'proj-1');
      expect(result._unsafeUnwrap().length).toBe(1);
      expect(result._unsafeUnwrap()[0].id).toBe('f-valid');
    });

    it('includes invalidated facts when requested', async () => {
      await insertFact(db, makeFact({ id: 'f-valid2', projectId: 'proj-1', invalidAt: null }));
      await insertFact(
        db,
        makeFact({ id: 'f-invalid2', projectId: 'proj-1', invalidAt: '2025-01-01T00:00:00Z' }),
      );

      const result = await listFacts(db, 'proj-1', { includeInvalidated: true });
      expect(result._unsafeUnwrap().length).toBe(2);
    });

    it('filters by type', async () => {
      await insertFact(db, makeFact({ id: 'f-dec', projectId: 'proj-1', type: 'decision' }));
      await insertFact(db, makeFact({ id: 'f-bug', projectId: 'proj-1', type: 'bug' }));

      const result = await listFacts(db, 'proj-1', { type: 'decision' });
      expect(result._unsafeUnwrap().length).toBe(1);
      expect(result._unsafeUnwrap()[0].type).toBe('decision');
    });

    it('respects limit', async () => {
      for (let i = 0; i < 10; i++) {
        await insertFact(db, makeFact({ id: `f-lim-${i}`, projectId: 'proj-1' }));
      }

      const result = await listFacts(db, 'proj-1', { limit: 3 });
      expect(result._unsafeUnwrap().length).toBe(3);
    });

    it('returns empty for unknown project', async () => {
      const result = await listFacts(db, 'nonexistent-project');
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toEqual([]);
    });
  });

  describe('deleteFact', () => {
    it('deletes an existing fact', async () => {
      const fact = makeFact({ id: 'fact-del' });
      await insertFact(db, fact);
      await deleteFact(db, 'fact-del');

      const result = await getFact(db, 'fact-del');
      expect(result.isErr()).toBe(true);
    });

    it('succeeds even for non-existing fact', async () => {
      const result = await deleteFact(db, 'nonexistent');
      expect(result.isOk()).toBe(true);
    });
  });

  // ─── Embedding storage ──────────────────────────────

  describe('embedding CRUD', () => {
    it('upserts and retrieves embeddings', async () => {
      const fact = makeFact({ id: 'fact-emb' });
      await insertFact(db, fact);

      const embedding = new Float32Array([0.1, 0.2, 0.3, 0.4]);
      const result = await upsertEmbedding(db, 'fact-emb', embedding);
      expect(result.isOk()).toBe(true);

      const all = await getAllEmbeddings(db);
      expect(all.isOk()).toBe(true);
      expect(all._unsafeUnwrap().length).toBe(1);
      expect(all._unsafeUnwrap()[0].factId).toBe('fact-emb');
    });

    it('deletes embedding', async () => {
      const fact = makeFact({ id: 'fact-emb-del' });
      await insertFact(db, fact);
      await upsertEmbedding(db, 'fact-emb-del', new Float32Array([1, 2, 3]));

      await deleteEmbedding(db, 'fact-emb-del');

      const all = await getAllEmbeddings(db);
      expect(all._unsafeUnwrap().length).toBe(0);
    });

    it('upsert replaces existing embedding', async () => {
      const fact = makeFact({ id: 'fact-emb-replace' });
      await insertFact(db, fact);

      await upsertEmbedding(db, 'fact-emb-replace', new Float32Array([1, 2, 3]));
      await upsertEmbedding(db, 'fact-emb-replace', new Float32Array([4, 5, 6]));

      const all = await getAllEmbeddings(db);
      expect(all._unsafeUnwrap().length).toBe(1);
    });
  });

  // ─── Meta key-value ─────────────────────────────────

  describe('meta', () => {
    it('sets and gets meta values', async () => {
      await setMeta(db, 'test-key', 'test-value');
      const value = await getMeta(db, 'test-key');
      expect(value).toBe('test-value');
    });

    it('returns null for non-existing key', async () => {
      const value = await getMeta(db, 'nonexistent');
      expect(value).toBeNull();
    });

    it('upserts on duplicate key', async () => {
      await setMeta(db, 'key', 'v1');
      await setMeta(db, 'key', 'v2');
      const value = await getMeta(db, 'key');
      expect(value).toBe('v2');
    });
  });

  // ─── Helpers ────────────────────────────────────────

  describe('generateFactId', () => {
    it('generates IDs with fact- prefix', () => {
      const id = generateFactId();
      expect(id).toMatch(/^fact-\d{4}-\d{2}-\d{2}-[a-z0-9]+$/);
    });

    it('generates unique IDs', () => {
      const ids = new Set(Array.from({ length: 100 }, () => generateFactId()));
      expect(ids.size).toBe(100);
    });
  });

  // ─── createDb ───────────────────────────────────────

  describe('createDb', () => {
    it('creates in-memory client', () => {
      const client = createDb({
        url: ':memory:',
        projectId: 'test',
        projectName: 'Test',
      });
      expect(client).toBeDefined();
    });
  });
});
