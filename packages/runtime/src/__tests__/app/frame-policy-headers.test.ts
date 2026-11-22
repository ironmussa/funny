/**
 * Issue #222: the runner CSP must let the app frame its own raw-file endpoint
 * (the PDF preview iframes `/api/files/raw`) while every other response stays
 * unframeable.
 */
import { describe, expect, it } from 'bun:test';

import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';

import { buildSecureHeadersConfig } from '../../app/setup-middleware.js';

function app() {
  const hono = new Hono();
  hono.use('*', secureHeaders(buildSecureHeadersConfig()));
  hono.get('/api/files/raw', (c) => c.body('%PDF-1.4', 200, { 'Content-Type': 'application/pdf' }));
  hono.get('/api/files/read', (c) => c.json({ ok: true }));
  return hono;
}

describe('runner frame policy (#222)', () => {
  it('allows same-origin frames on every response', async () => {
    const res = await app().request('/api/files/read');
    const csp = res.headers.get('Content-Security-Policy') ?? '';
    expect(csp).toContain("frame-src 'self'");
    expect(csp).not.toContain("frame-src 'none'");
  });

  it('lets only the app frame the raw-file response', async () => {
    const res = await app().request('/api/files/raw?path=/tmp/a.pdf');
    const csp = res.headers.get('Content-Security-Policy') ?? '';
    expect(csp).toContain("frame-ancestors 'self'");
    expect(res.headers.get('X-Frame-Options')).toBe('SAMEORIGIN');
  });

  it('keeps frame-ancestors none elsewhere', async () => {
    const res = await app().request('/api/files/read');
    expect(res.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
  });
});
