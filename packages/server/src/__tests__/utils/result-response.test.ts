import { describe, test, expect } from 'bun:test';
import { Hono } from 'hono';
import { ok, err } from 'neverthrow';
import { resultToResponse } from '../../utils/result-response.js';
import {
  notFound,
  badRequest,
  forbidden,
  validationErr,
  processError,
  conflict,
  internal,
} from '@funny/shared/errors';

describe('resultToResponse', () => {
  function createApp(handler: (c: any) => Response | Promise<Response>) {
    const app = new Hono();
    app.get('/test', handler);
    return app;
  }

  // ── Success responses ──────────────────────────────────────

  test('ok result returns 200 by default', async () => {
    const app = createApp((c) =>
      resultToResponse(c, ok({ id: '1', name: 'Test' }))
    );

    const res = await app.request('/test');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ id: '1', name: 'Test' });
  });

  test('ok result returns custom success status (201)', async () => {
    const app = createApp((c) =>
      resultToResponse(c, ok({ created: true }), 201)
    );

    const res = await app.request('/test');
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toEqual({ created: true });
  });

  test('ok result returns custom success status (204)', async () => {
    const app = createApp((c) =>
      resultToResponse(c, ok(null), 204)
    );

    const res = await app.request('/test');
    expect(res.status).toBe(204);
  });

  test('ok result with array value', async () => {
    const app = createApp((c) =>
      resultToResponse(c, ok([{ id: '1' }, { id: '2' }]))
    );

    const res = await app.request('/test');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([{ id: '1' }, { id: '2' }]);
  });

  // ── Error responses ────────────────────────────────────────

  test('err(notFound) returns 404', async () => {
    const app = createApp((c) =>
      resultToResponse(c, err(notFound('Project not found')))
    );

    const res = await app.request('/test');
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: 'Project not found' });
  });

  test('err(badRequest) returns 400', async () => {
    const app = createApp((c) =>
      resultToResponse(c, err(badRequest('Missing required field')))
    );

    const res = await app.request('/test');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ error: 'Missing required field' });
  });

  test('err(forbidden) returns 403', async () => {
    const app = createApp((c) =>
      resultToResponse(c, err(forbidden('Access denied')))
    );

    const res = await app.request('/test');
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toEqual({ error: 'Access denied' });
  });

  test('err(validationErr) returns 400', async () => {
    const app = createApp((c) =>
      resultToResponse(c, err(validationErr('name is required')))
    );

    const res = await app.request('/test');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ error: 'name is required' });
  });

  test('err(processError) returns 400', async () => {
    const app = createApp((c) =>
      resultToResponse(c, err(processError('git diff failed', 1, 'fatal error')))
    );

    const res = await app.request('/test');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ error: 'git diff failed' });
  });

  test('err(conflict) returns 409', async () => {
    const app = createApp((c) =>
      resultToResponse(c, err(conflict('Branch already exists')))
    );

    const res = await app.request('/test');
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toEqual({ error: 'Branch already exists' });
  });

  test('err(internal) returns 500', async () => {
    const app = createApp((c) =>
      resultToResponse(c, err(internal('Unexpected database failure')))
    );

    const res = await app.request('/test');
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: 'Unexpected database failure' });
  });

  // ── Edge cases ─────────────────────────────────────────────

  test('error response body always has error key with string message', async () => {
    const errors = [
      notFound('a'),
      badRequest('b'),
      forbidden('c'),
      validationErr('d'),
      processError('e'),
      conflict('f'),
      internal('g'),
    ];

    for (const domainError of errors) {
      const app = createApp((c) => resultToResponse(c, err(domainError)));
      const res = await app.request('/test');
      const body = await res.json();
      expect(body).toHaveProperty('error');
      expect(typeof body.error).toBe('string');
    }
  });

  test('ok result with empty object', async () => {
    const app = createApp((c) => resultToResponse(c, ok({})));

    const res = await app.request('/test');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({});
  });

  test('ok result with nested objects', async () => {
    const data = {
      project: { id: '1', threads: [{ id: 't1', messages: [] }] },
    };
    const app = createApp((c) => resultToResponse(c, ok(data)));

    const res = await app.request('/test');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(data);
  });
});
