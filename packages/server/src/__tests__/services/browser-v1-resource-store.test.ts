import { describe, expect, test } from 'bun:test';

import { Hono } from 'hono';

import type { ServerEnv } from '../../lib/types.js';
import { browserV1ResourceRoutes } from '../../routes/browser-v1-resources.js';
import {
  BrowserV1ResourceStore,
  browserV1ResourceStore,
} from '../../services/socketio/browser-v1-resource-store.js';

describe('browser.v1 authorized resource store', () => {
  test('bounds resources, isolates principals, and expires bytes', () => {
    let now = 1_000;
    let id = 0;
    const store = new BrowserV1ResourceStore({
      maxResourceBytes: 4,
      maxTotalBytes: 6,
      retentionMs: 100,
      now: () => now,
      id: () => `resource-${++id}`,
    });
    const first = store.put('user-1', new Uint8Array([1, 2, 3]), 'image/jpeg');
    expect(first).toMatchObject({ id: 'resource-1', userId: 'user-1', mediaType: 'image/jpeg' });
    expect(store.get('resource-1', 'user-2')).toBeUndefined();
    const second = store.put('user-1', new Uint8Array([4, 5, 6, 7]), 'image/jpeg');
    expect(second?.id).toBe('resource-2');
    expect(store.get('resource-1', 'user-1')).toBeUndefined();
    expect(store.put('user-1', new Uint8Array(5), 'image/jpeg')).toBeNull();
    now += 101;
    expect(store.get('resource-2', 'user-1')).toBeUndefined();
  });

  test('serves no-store bytes only to the authenticated owner', async () => {
    const resource = browserV1ResourceStore.put(
      'user-1',
      new TextEncoder().encode('frame'),
      'image/jpeg',
    );
    const app = new Hono<ServerEnv>();
    app.use('*', async (c, next) => {
      c.set('userId', c.req.header('x-test-user') ?? '');
      await next();
    });
    app.route('/resources', browserV1ResourceRoutes);
    const allowed = await app.request(`/resources/${resource?.id}`, {
      headers: { 'x-test-user': 'user-1' },
    });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get('cache-control')).toContain('no-store');
    expect(await allowed.text()).toBe('frame');
    const denied = await app.request(`/resources/${resource?.id}`, {
      headers: { 'x-test-user': 'user-2' },
    });
    expect(denied.status).toBe(404);
  });
});
