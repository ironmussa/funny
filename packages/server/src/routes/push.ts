import { Hono } from 'hono';
import { z } from 'zod';

import type { ServerEnv } from '../lib/types.js';
import {
  pushConfig,
  removeSubscription,
  saveSubscription,
  sendPush,
  subscriptionSchema,
} from '../services/web-push.js';

export const pushRoutes = new Hono<ServerEnv>();
pushRoutes.get('/config', (c) => c.json({ publicKey: pushConfig()?.publicKey ?? null }));
pushRoutes.put('/subscription', async (c) => {
  if (!pushConfig()) return c.json({ error: 'Web Push is not configured on the server' }, 503);
  const parsed = subscriptionSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'Invalid push subscription' }, 400);
  await saveSubscription(c.get('userId'), parsed.data);
  return c.json({ ok: true });
});
pushRoutes.delete('/subscription', async (c) => {
  const parsed = z
    .object({ endpoint: z.string().max(4096) })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'Invalid endpoint' }, 400);
  await removeSubscription(c.get('userId'), parsed.data.endpoint);
  return c.json({ ok: true });
});
pushRoutes.post('/test', async (c) => {
  const parsed = z
    .object({ endpoint: z.string().max(4096) })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'Invalid endpoint' }, 400);
  const sent = await sendPush(
    c.get('userId'),
    { title: 'funny', body: 'Web Push is working', url: '/', tag: 'push-test' },
    parsed.data.endpoint,
  );
  return sent
    ? c.json({ ok: true })
    : c.json({ error: 'Push delivery failed or subscription unavailable' }, 503);
});
