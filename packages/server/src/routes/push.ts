/**
 * Web Push REST routes. The logic lives in `trpc/ports/insights.ts`, shared
 * with the `push` tRPC procedures (openspec adopt-trpc-browser-api).
 */

import { pushEndpointBody, pushSubscriptionBody } from '@funny/shared/contracts/push';
import { Hono } from 'hono';

import type { ServerEnv } from '../lib/types.js';
import { pushPort as port } from '../trpc/ports/insights.js';
import { answerJson } from '../trpc/reply.js';

export const pushRoutes = new Hono<ServerEnv>();

pushRoutes.get('/config', (c) => answerJson(c, port.config()));

pushRoutes.put('/subscription', async (c) => {
  // Not configured answers 503 before the body is read, as it always has.
  const config = (await port.config())._unsafeUnwrap();
  if (!config.publicKey) return c.json({ error: 'Web Push is not configured on the server' }, 503);
  const parsed = pushSubscriptionBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'Invalid push subscription' }, 400);
  return answerJson(c, port.subscribe(c.get('userId'), parsed.data));
});

pushRoutes.delete('/subscription', async (c) => {
  const parsed = pushEndpointBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'Invalid endpoint' }, 400);
  return answerJson(c, port.unsubscribe(c.get('userId'), parsed.data.endpoint));
});

pushRoutes.post('/test', async (c) => {
  const parsed = pushEndpointBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'Invalid endpoint' }, 400);
  return answerJson(c, port.test(c.get('userId'), parsed.data.endpoint));
});
