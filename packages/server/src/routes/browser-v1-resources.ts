import { Hono } from 'hono';

import type { ServerEnv } from '../lib/types.js';
import { browserV1ResourceStore } from '../services/socketio/browser-v1-resource-store.js';

export const browserV1ResourceRoutes = new Hono<ServerEnv>();

browserV1ResourceRoutes.get('/:id', (c) => {
  const resource = browserV1ResourceStore.get(c.req.param('id'), c.get('userId'));
  if (!resource) return c.json({ error: 'Resource not found' }, 404);
  const body = resource.bytes.buffer.slice(
    resource.bytes.byteOffset,
    resource.bytes.byteOffset + resource.bytes.byteLength,
  ) as ArrayBuffer;
  return new Response(body, {
    headers: {
      'content-type': resource.mediaType,
      'content-length': String(resource.bytes.byteLength),
      'cache-control': 'private, no-store, max-age=0',
      etag: resource.entityTag,
      expires: resource.expiresAt.toUTCString(),
      'x-content-type-options': 'nosniff',
    },
  });
});
