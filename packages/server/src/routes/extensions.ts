import { Hono } from 'hono';

import {
  discoverExtensions,
  installExtensionFromPath,
  listInstalledExtensions,
  removeExtension,
} from '../lib/extensions.js';
import type { ServerEnv } from '../lib/types.js';
import { requireAdmin } from '../middleware/auth.js';

/**
 * `/api/extensions` — installed client extensions (visualizer plugins).
 * Mounted under the authenticated `/api/*` tree, before the runner proxy
 * catch-all. Global to the server (not per-user) in v1.
 */
export const extensionRoutes = new Hono<ServerEnv>();

// Loader manifest — minimal shape the client dynamically imports + registers.
extensionRoutes.get('/', (c) => {
  c.header('Cache-Control', 'no-store');
  return c.json(discoverExtensions());
});

// Richer list for the management UI / CLI (dir name, id, version, description).
extensionRoutes.get('/installed', (c) => {
  c.header('Cache-Control', 'no-store');
  return c.json(listInstalledExtensions());
});

// Install by copying a local pre-built package directory on the server host.
// Admin-only: extensions are global and the installed JS is dynamically
// imported into EVERY user's client, so a non-admin must not be able to push
// code (or read arbitrary server-host directories via the `path` arg).
extensionRoutes.post('/install', requireAdmin, async (c) => {
  let body: { path?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400);
  }
  if (typeof body.path !== 'string' || !body.path.trim()) {
    return c.json({ error: 'a local "path" to the extension package is required' }, 400);
  }
  const result = installExtensionFromPath(body.path.trim());
  if (!result.ok) return c.json({ error: result.error }, 400);
  return c.json({ extension: result.extension });
});

// Remove an installed extension by its on-disk directory name. Admin-only —
// removal is a server-global mutation affecting every user.
extensionRoutes.delete('/:name', requireAdmin, (c) => {
  const result = removeExtension(c.req.param('name') ?? '');
  if (!result.ok) {
    return c.json({ error: result.error }, result.error === 'extension not found' ? 404 : 400);
  }
  return c.json({ ok: true });
});
