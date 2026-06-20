import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { z } from 'zod';

import { parseJsonBody, parseQuery, queryBoolean, queryList } from '../../validation/request.js';

const bodySchema = z.object({
  name: z.string().min(1, 'name is required'),
});

function createApp() {
  const app = new Hono();
  app.post('/test', async (c) => {
    const parsed = await parseJsonBody(c, bodySchema);
    return parsed.match(
      (value) => c.json({ ok: true, value }),
      (error) => c.json({ error: error.message, type: error.type }, 400),
    );
  });
  return app;
}

describe('parseJsonBody', () => {
  test('returns typed parsed body for valid JSON', async () => {
    const res = await createApp().request('/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Ada' }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, value: { name: 'Ada' } });
  });

  test('returns validation error for schema mismatch', async () => {
    const res = await createApp().request('/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '' }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'name is required', type: 'VALIDATION' });
  });

  test('returns validation error for invalid JSON', async () => {
    const res = await createApp().request('/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid JSON request body', type: 'VALIDATION' });
  });
});

describe('parseQuery', () => {
  const querySchema = z.object({
    limit: z.coerce.number().int().min(1),
    enabled: queryBoolean,
    mode: z.enum(['fast', 'safe']),
    labels: queryList(z.string()).optional(),
  });

  function createQueryApp() {
    const app = new Hono();
    app.get('/test', (c) => {
      const parsed = parseQuery(c, querySchema);
      return parsed.match(
        (value) => c.json({ ok: true, value }),
        (error) => c.json({ error: error.message, type: error.type }, 400),
      );
    });
    return app;
  }

  test('coerces typed query parameters', async () => {
    const res = await createQueryApp().request(
      '/test?limit=10&enabled=false&mode=fast&labels=bug,ui&labels=api',
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      value: { limit: 10, enabled: false, mode: 'fast', labels: ['bug', 'ui', 'api'] },
    });
  });

  test('returns validation error for invalid typed query parameters', async () => {
    const res = await createQueryApp().request('/test?limit=0&enabled=maybe&mode=slow');

    expect(res.status).toBe(400);
    expect((await res.json()).type).toBe('VALIDATION');
  });
});
