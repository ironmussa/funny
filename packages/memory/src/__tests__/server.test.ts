import type { Client } from '@libsql/client';
import { Hono } from 'hono';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

import { createDb, initSchema, insertFact, listFacts } from '../storage.js';
import type { StorageConfig } from '../types.js';
import { makeFact } from './helpers.js';

// Mock the embedding provider
vi.mock('../embedding.js', () => ({
  createEmbeddingProvider: vi.fn().mockResolvedValue({
    embed: vi.fn().mockResolvedValue(new Float32Array(0)),
    embedBatch: vi
      .fn()
      .mockImplementation((texts: string[]) =>
        Promise.resolve(texts.map(() => new Float32Array(0))),
      ),
    dimensions: vi.fn().mockReturnValue(0),
    modelId: vi.fn().mockReturnValue('null'),
  }),
}));

/**
 * Build a mini test app that mimics server.ts routes
 * without actually starting a server process.
 * We import and test the route logic directly.
 */
describe('server HTTP endpoints (integration)', () => {
  // Since server.ts is a standalone script that starts listening,
  // we'll test the core route logic by constructing a Hono app
  // with the same handlers against an in-memory DB.

  let db: Client;
  let app: Hono;
  const projectId = 'server-test-project';
  const projectName = 'Server Test';

  beforeAll(async () => {
    db = createDb({ url: ':memory:', projectId, projectName });
    await initSchema(db);

    // We'll build a lightweight Hono app that exercises the same logic
    app = new Hono();

    // Health endpoint
    app.get('/health', (c) => c.json({ status: 'ok', projectId }));

    // POST /v1/facts - add a fact
    app.post('/v1/facts', async (c) => {
      const body = await c.req.json();
      const now = new Date().toISOString();
      const fact = makeFact({
        id: `fact-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        projectId,
        content: body.content,
        type: body.type ?? 'insight',
        tags: body.tags ?? [],
        confidence: body.confidence ?? 0.8,
      });
      const result = await insertFact(db, fact);
      if (result.isErr()) return c.json({ error: result.error }, 500);
      return c.json(fact, 201);
    });

    // GET /v1/facts - list facts
    app.get('/v1/facts', async (c) => {
      const type = c.req.query('type');
      const result = await listFacts(db, projectId, { type: type ?? undefined });
      if (result.isErr()) return c.json({ error: result.error }, 500);
      return c.json({ facts: result.value });
    });

    // PATCH /v1/facts/:id/invalidate
    app.patch('/v1/facts/:id/invalidate', async (c) => {
      const { updateFact, getFact } = await import('../storage.js');
      const factId = c.req.param('id');
      const body = await c.req.json().catch(() => ({}));

      const factResult = await getFact(db, factId);
      if (factResult.isErr()) return c.json({ error: 'Not found' }, 404);

      await updateFact(db, factId, {
        invalid_at: new Date().toISOString(),
        invalidated_by: (body as any).reason ?? null,
      });
      return c.json({ ok: true });
    });

    // PATCH /v1/facts/:id/evolve
    app.patch('/v1/facts/:id/evolve', async (c) => {
      const { updateFact, getFact } = await import('../storage.js');
      const factId = c.req.param('id');
      const body = await c.req.json();

      const factResult = await getFact(db, factId);
      if (factResult.isErr()) return c.json({ error: 'Not found' }, 404);

      const fact = factResult.value;
      if (fact.invalidAt) return c.json({ error: 'Cannot evolve invalidated fact' }, 400);

      const newContent = `${fact.content}\n\n---\n_Updated: ${(body as any).update}_`;
      await updateFact(db, factId, {
        content: newContent,
        ingested_at: new Date().toISOString(),
      });

      const updatedResult = await getFact(db, factId);
      return c.json(updatedResult.isOk() ? updatedResult.value : {});
    });
  });

  afterAll(() => {
    db?.close();
  });

  // ─── Health ─────────────────────────────────────────

  describe('GET /health', () => {
    it('returns status ok', async () => {
      const res = await app.request('/health');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('ok');
      expect(body.projectId).toBe(projectId);
    });
  });

  // ─── POST /v1/facts ─────────────────────────────────

  describe('POST /v1/facts', () => {
    it('creates a new fact', async () => {
      const res = await app.request('/v1/facts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: 'Test fact for server integration',
          type: 'insight',
          tags: ['test'],
        }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.content).toBe('Test fact for server integration');
      expect(body.type).toBe('insight');
      expect(body.tags).toContain('test');
    });

    it('uses default values for optional fields', async () => {
      const res = await app.request('/v1/facts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'Minimal fact' }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.type).toBe('insight');
      expect(body.confidence).toBe(0.8);
    });
  });

  // ─── GET /v1/facts ──────────────────────────────────

  describe('GET /v1/facts', () => {
    it('lists facts', async () => {
      const res = await app.request('/v1/facts');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body.facts)).toBe(true);
      expect(body.facts.length).toBeGreaterThan(0);
    });

    it('filters by type', async () => {
      // Add a decision fact
      await app.request('/v1/facts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'A decision', type: 'decision' }),
      });

      const res = await app.request('/v1/facts?type=decision');
      const body = await res.json();
      expect(body.facts.every((f: any) => f.type === 'decision')).toBe(true);
    });
  });

  // ─── PATCH /v1/facts/:id/invalidate ─────────────────

  describe('PATCH /v1/facts/:id/invalidate', () => {
    it('invalidates a fact', async () => {
      // Create a fact first
      const createRes = await app.request('/v1/facts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'To be invalidated' }),
      });
      const created = await createRes.json();

      const res = await app.request(`/v1/facts/${created.id}/invalidate`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'outdated' }),
      });
      expect(res.status).toBe(200);
    });

    it('returns 404 for non-existing fact', async () => {
      const res = await app.request('/v1/facts/nonexistent/invalidate', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(404);
    });
  });

  // ─── PATCH /v1/facts/:id/evolve ─────────────────────

  describe('PATCH /v1/facts/:id/evolve', () => {
    it('evolves a fact', async () => {
      const createRes = await app.request('/v1/facts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'Original content' }),
      });
      const created = await createRes.json();

      const res = await app.request(`/v1/facts/${created.id}/evolve`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ update: 'New information' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.content).toContain('Original content');
      expect(body.content).toContain('New information');
    });

    it('returns 404 for non-existing fact', async () => {
      const res = await app.request('/v1/facts/nonexistent/evolve', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ update: 'x' }),
      });
      expect(res.status).toBe(404);
    });
  });
});
