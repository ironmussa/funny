import { describe, test, expect, beforeEach } from 'bun:test';

import { eq } from 'drizzle-orm';
import { Hono } from 'hono';

import { createTestDb, seedProject } from '../helpers/test-db.js';

describe('Project Routes', () => {
  let app: Hono;
  let testDb: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    testDb = createTestDb();

    app = new Hono();

    // GET /
    app.get('/', (c) => {
      const projects = testDb.db.select().from(testDb.schema.projects).all();
      return c.json(projects);
    });

    // POST /
    app.post('/', async (c) => {
      const { name, path } = await c.req.json<{ name: string; path: string }>();
      if (!name || !path) {
        return c.json({ error: 'name and path are required' }, 400);
      }
      const project = {
        id: 'gen-id',
        name,
        path,
        createdAt: new Date().toISOString(),
      };
      testDb.db.insert(testDb.schema.projects).values(project).run();
      return c.json(project, 201);
    });

    // DELETE /:id
    app.delete('/:id', (c) => {
      const id = c.req.param('id');
      testDb.db.delete(testDb.schema.projects).where(eq(testDb.schema.projects.id, id)).run();
      return c.json({ ok: true });
    });

    // GET /:id
    app.get('/:id', (c) => {
      const id = c.req.param('id');
      const project = testDb.db
        .select()
        .from(testDb.schema.projects)
        .where(eq(testDb.schema.projects.id, id))
        .get();
      if (!project) {
        return c.json({ error: 'Project not found' }, 404);
      }
      return c.json(project);
    });
  });

  test('GET / returns empty array when no projects', async () => {
    const res = await app.request('/');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });

  test('GET / returns all projects', async () => {
    seedProject(testDb.db, { id: 'p1', name: 'Project 1' });
    seedProject(testDb.db, { id: 'p2', name: 'Project 2' });

    const res = await app.request('/');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(2);
  });

  test('POST / creates a project', async () => {
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'New Project', path: '/tmp/repo' }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.name).toBe('New Project');
    expect(body.path).toBe('/tmp/repo');
    expect(body.id).toBeTruthy();
  });

  test('POST / returns 400 when name is missing', async () => {
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/tmp/repo' }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeTruthy();
  });

  test('POST / returns 400 when path is missing', async () => {
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Project' }),
    });

    expect(res.status).toBe(400);
  });

  test('DELETE /:id removes the project', async () => {
    seedProject(testDb.db, { id: 'to-delete' });

    const res = await app.request('/to-delete', { method: 'DELETE' });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ok).toBe(true);

    const projects = testDb.db.select().from(testDb.schema.projects).all();
    expect(projects).toHaveLength(0);
  });

  test('GET /:id returns project', async () => {
    seedProject(testDb.db, { id: 'p1', name: 'Found' });

    const res = await app.request('/p1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe('Found');
  });

  test('GET /:id returns 404 for non-existent project', async () => {
    const res = await app.request('/nonexistent');
    expect(res.status).toBe(404);
  });
});
