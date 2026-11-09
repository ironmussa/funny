/**
 * Bun host: assets served from disk after the API routes — installed client
 * extensions (`<DATA_DIR>/extensions/`) and the built client bundle with its
 * SPA fallback. Another host (e.g. Workers Static Assets) provides its own.
 */

import { existsSync } from 'fs';
import { join } from 'path';

import type { Hono } from 'hono';
import { serveStatic } from 'hono/bun';

import { extensionAssetContentType, resolveExtensionAsset } from '../../lib/extensions.js';
import { log } from '../../lib/logger.js';
import type { ServerEnv } from '../../lib/types.js';

export function mountBunAssets(app: Hono<ServerEnv>, clientDistDir: string): void {
  // ── Installed client extensions (visualizer plugins) ──────
  // Serve pre-built ESM assets from <DATA_DIR>/extensions/<name>/. Registered
  // before the static client + SPA catch-all so these paths are not shadowed.
  // Not under /api, so unauthenticated like the rest of the client bundle; the
  // browser dynamically imports these as same-origin modules (script-src 'self').
  // Path traversal + symlink escape are blocked by `resolveExtensionAsset`.
  app.get('/extensions/:name/*', async (c) => {
    const name = c.req.param('name');
    const prefix = `/extensions/${name}/`;
    const rest = c.req.path.startsWith(prefix) ? c.req.path.slice(prefix.length) : '';
    let relPath: string;
    try {
      relPath = decodeURIComponent(rest);
    } catch {
      return c.notFound();
    }
    const file = resolveExtensionAsset(decodeURIComponent(name), relPath);
    if (!file) return c.notFound();
    c.header('Content-Type', extensionAssetContentType(file));
    // Extension entry URLs are NOT content-hashed (e.g. dist/index.mjs), so they
    // must revalidate — otherwise reinstalling/updating an extension keeps serving
    // a stale bundle from the browser cache. `no-store` keeps it always fresh.
    // (A future optimization could content-hash the URL and cache immutably.)
    c.header('Cache-Control', 'no-store');
    return c.body(await Bun.file(file).arrayBuffer());
  });

  // Serve static files from client build (only if dist exists)
  // Security L3: static responses inherit X-Content-Type-Options: nosniff from
  // the global `secureHeaders()` middleware registered in app.ts — do not
  // disable its `xContentTypeOptions` default, or browsers will MIME-sniff
  // bundled assets and could execute attacker-controlled content under the
  // server origin.
  if (existsSync(clientDistDir)) {
    app.use('/*', serveStatic({ root: clientDistDir }));
    app.get('*', async (c) => {
      return c.html(await Bun.file(join(clientDistDir, 'index.html')).text());
    });
    log.info('Serving static files', { namespace: 'server', dir: clientDistDir });
  }
}
