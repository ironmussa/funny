/**
 * @domain subdomain: Thread Management
 * @domain subdomain-type: core
 * @domain type: adapter
 * @domain layer: infrastructure
 *
 * POST /api/uploads/staging — park an attachment for a thread that does not
 * exist yet (the first message of a new thread). Returns a `stagedId` the
 * client passes as `stagedUploads` on thread creation. The server routes this
 * like any proxied request: `?projectId=` picks the project's runner, no
 * query picks a projectless (general) runner — the same runner the thread
 * creation will resolve to.
 */
import { Hono } from 'hono';

import { stageUpload } from '../services/thread-service/staged-uploads.js';
import type { HonoEnv } from '../types/hono-env.js';
import { resultToResponse } from '../utils/result-response.js';
import { parseJsonBody } from '../validation/request.js';
import { uploadFileSchema } from '../validation/schemas.js';

export const uploadRoutes = new Hono<HonoEnv>();

uploadRoutes.post('/staging', async (c) => {
  const parsed = await parseJsonBody(c, uploadFileSchema);
  if (parsed.isErr()) return resultToResponse(c, parsed);
  return resultToResponse(
    c,
    await stageUpload({ userId: c.get('userId') as string, ...parsed.value }),
  );
});
