/**
 * Security HI-7 regression tests — Hono's `csrf()` middleware locks down
 * form-submittable cross-site POSTs (the CORS-"simple" content types that
 * browsers send without preflight). JSON traffic is unaffected (it
 * triggers CORS preflight).
 */
import { describe, expect, test } from 'bun:test';

import { Hono } from 'hono';
import { csrf as honoCsrf } from 'hono/csrf';

describe('hono/csrf middleware contract (security HI-7)', () => {
  const allowed = ['http://localhost:5173', 'http://127.0.0.1:5173'];

  function buildApp(): Hono {
    const app = new Hono();
    app.use('*', honoCsrf({ origin: allowed }));
    app.post('/api/threads', (c) => c.json({ ok: true }));
    return app;
  }

  test('rejects form-urlencoded POST with no Origin', async () => {
    const app = buildApp();
    const res = await app.request('/api/threads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'foo=bar',
    });
    expect(res.status).toBe(403);
  });

  test('rejects multipart POST with attacker Origin', async () => {
    const app = buildApp();
    const res = await app.request('/api/threads', {
      method: 'POST',
      headers: {
        'Content-Type': 'multipart/form-data; boundary=x',
        Origin: 'https://attacker.example',
      },
      body: '--x--',
    });
    expect(res.status).toBe(403);
  });

  test('allows form-urlencoded POST when Origin matches allowlist', async () => {
    const app = buildApp();
    const res = await app.request('/api/threads', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: 'http://localhost:5173',
      },
      body: 'foo=bar',
    });
    expect(res.status).toBe(200);
  });

  test('does NOT block application/json POSTs (CORS preflight handles those)', async () => {
    const app = buildApp();
    const res = await app.request('/api/threads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"x":1}',
    });
    expect(res.status).toBe(200);
  });

  test('treats missing Content-Type as form-like (defensive default)', async () => {
    const app = buildApp();
    const res = await app.request('/api/threads', { method: 'POST', body: 'x' });
    // Without Content-Type, Hono defaults to text/plain which is in the
    // form-submittable set — so no Origin means 403.
    expect(res.status).toBe(403);
  });

  test('GET is always allowed (safe method)', async () => {
    const app = new Hono();
    app.use('*', honoCsrf({ origin: allowed }));
    app.get('/api/threads', (c) => c.json([]));
    const res = await app.request('/api/threads');
    expect(res.status).toBe(200);
  });

  test('Sec-Fetch-Site: same-origin satisfies the gate even without Origin', async () => {
    const app = buildApp();
    const res = await app.request('/api/threads', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Sec-Fetch-Site': 'same-origin',
      },
      body: 'x=1',
    });
    expect(res.status).toBe(200);
  });
});
