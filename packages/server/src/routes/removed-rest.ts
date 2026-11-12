/**
 * REST groups that only tRPC serves now (openspec adopt-trpc-browser-api).
 *
 * A path the server stops answering falls through to the runner proxy
 * catch-all and reaches the user's runner, which would then be the one to
 * decide what the request may do. These handlers answer 404 on the server, so a
 * removed path never leaves it.
 */

import type { Context } from 'hono';
import { Hono } from 'hono';

import type { ServerEnv } from '../lib/types.js';

export const refuseRemovedRoute = (c: Context<ServerEnv>) => c.json({ error: 'Not found' }, 404);

/** `/api/automations`: every route moved to the `automations` tRPC procedures. */
export const removedAutomationRoutes = new Hono<ServerEnv>().all('*', refuseRemovedRoute);
