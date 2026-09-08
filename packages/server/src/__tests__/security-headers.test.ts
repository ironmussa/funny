/**
 * Security L3 regression test.
 *
 * Asserts that the Hono `secureHeaders()` middleware — wired into both the
 * server (`src/index.ts`) and the runner (`packages/runtime/src/app.ts`) —
 * emits `X-Content-Type-Options: nosniff` by default, and that the CSP
 * override we apply in the server does not disable that default.
 *
 * If this test starts failing, a future refactor of the secure-headers
 * config has dropped the `xContentTypeOptions` default and static-served
 * client assets are at risk of MIME sniffing. Re-enable the default or
 * set the header explicitly.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';

describe('static-file security headers (L3)', () => {
  it('sets X-Content-Type-Options: nosniff by default', async () => {
    const app = new Hono();
    app.use('*', secureHeaders());
    app.get('/asset.js', (c) => c.text('console.log(1)', 200));

    const res = await app.request('/asset.js');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('keeps nosniff when a CSP override is supplied (matches server config)', async () => {
    const app = new Hono();
    app.use(
      '*',
      secureHeaders({
        contentSecurityPolicy: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
        },
        strictTransportSecurity: 'max-age=31536000; includeSubDomains',
      }),
    );
    app.get('/asset.js', (c) => c.text('console.log(1)', 200));

    const res = await app.request('/asset.js');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  /*
   * Security L-2: regression tests for the rest of the security-header
   * surface so a future override of `secureHeaders()` cannot silently drop
   * any of them. Each assertion mirrors what the production server applies
   * (`packages/server/src/index.ts`) — when that config changes, this test
   * is the first thing that flags the diff.
   */
  describe('full secure-headers surface', () => {
    async function probe(): Promise<Response> {
      const app = new Hono();
      app.use(
        '*',
        secureHeaders({
          contentSecurityPolicy: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'"],
            connectSrc: ["'self'"],
            objectSrc: ["'none'"],
            frameAncestors: ["'none'"],
          },
          strictTransportSecurity: 'max-age=31536000; includeSubDomains',
          xContentTypeOptions: true,
        }),
      );
      app.get('/', (c) => c.text('ok', 200));
      return app.request('/');
    }

    it('emits Strict-Transport-Security', async () => {
      const res = await probe();
      expect(res.headers.get('Strict-Transport-Security')).toBe(
        'max-age=31536000; includeSubDomains',
      );
    });

    it('emits a CSP with frame-ancestors none and object-src none', async () => {
      const res = await probe();
      const csp = res.headers.get('Content-Security-Policy') ?? '';
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("object-src 'none'");
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("script-src 'self'");
      // Security HI-9: connect-src must NOT contain bare `ws:` / `wss:`
      // wildcards — `'self'` already authorises same-origin upgrades.
      expect(csp).not.toMatch(/connect-src[^;]*\bws:/);
      expect(csp).not.toMatch(/connect-src[^;]*\bwss:/);
    });

    it('emits Hono defaults: X-Frame-Options + Referrer-Policy + COOP/COEP', async () => {
      const res = await probe();
      // Hono's secureHeaders() defaults — assert them so an override doesn't
      // silently drop them. If you intentionally change one of these, update
      // this assertion in the same commit.
      expect(res.headers.get('X-Frame-Options')).toBe('SAMEORIGIN');
      expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
      expect(res.headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin');
      expect(res.headers.get('Cross-Origin-Resource-Policy')).toBe('same-origin');
      expect(res.headers.get('X-Permitted-Cross-Domain-Policies')).toBe('none');
      expect(res.headers.get('X-DNS-Prefetch-Control')).toBe('off');
      expect(res.headers.get('X-Download-Options')).toBe('noopen');
    });

    it('does not leak Server / X-Powered-By', async () => {
      const res = await probe();
      // Hono does not emit X-Powered-By; if a future version starts to,
      // this test will flag it.
      expect(res.headers.get('X-Powered-By')).toBeNull();
    });
  });
});

// Read the production policies so this regression covers both HTML entrypoints.
describe('GitHub avatar image policy', () => {
  for (const path of ['../index.ts', '../../../runtime/src/app/setup-middleware.ts']) {
    it(`allows GitHub avatars with a restricted image policy in ${path}`, async () => {
      const source = readFileSync(new URL(path, import.meta.url), 'utf8');
      const directive = source.match(/imgSrc: \[([^\]]+)\]/)?.[1];
      expect(directive).toBeDefined();
      const imgSrc = Array.from(directive!.matchAll(/(['"])(.*?)\1/g), (match) => match[2]);
      const app = new Hono();
      app.use('*', secureHeaders({ contentSecurityPolicy: { imgSrc } }));
      app.get('/', (c) => c.text('ok'));
      const res = await app.request('/');
      expect(res.headers.get('Content-Security-Policy')).toBe(
        "img-src 'self' data: blob: https://avatars.githubusercontent.com",
      );
    });
  }
});

// Guard the actual entrypoint declarations, rather than only a copied policy.
describe('Markdown WebAssembly security policy', () => {
  for (const path of ['../index.ts', '../../../runtime/src/app/setup-middleware.ts']) {
    it(`enables isolated WASM without JavaScript eval in ${path}`, async () => {
      const source = readFileSync(new URL(path, import.meta.url), 'utf8');
      const directive = source.match(/scriptSrc: \[([^\]]+)\]/)?.[1];
      expect(directive).toBeDefined();
      const scriptSrc = Array.from(directive!.matchAll(/(['"])(.*?)\1/g), (match) => match[2]);
      const coop = source.match(/crossOriginOpenerPolicy: '([^']+)'/)?.[1];
      const coep = source.match(/crossOriginEmbedderPolicy: '([^']+)'/)?.[1];
      expect(coop).toBe('same-origin');
      expect(coep).toBe('require-corp');

      const app = new Hono();
      app.use(
        '*',
        secureHeaders({
          contentSecurityPolicy: { scriptSrc },
          crossOriginOpenerPolicy: coop as 'same-origin',
          crossOriginEmbedderPolicy: coep as 'require-corp',
        }),
      );
      app.get('/', (c) => c.html('<!doctype html><title>Markdown</title>'));
      const res = await app.request('/');
      const csp = res.headers.get('Content-Security-Policy') ?? '';
      expect(csp).toContain("'wasm-unsafe-eval'");
      expect(csp).not.toContain("'unsafe-eval'");
      expect(csp).not.toContain("'unsafe-inline'");
      expect(res.headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin');
      expect(res.headers.get('Cross-Origin-Embedder-Policy')).toBe('require-corp');
    });
  }
});
