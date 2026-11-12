/**
 * User profile REST routes for the central server.
 *
 * The logic lives in `trpc/ports/profile.ts`, shared with the `profile` tRPC
 * procedures (openspec adopt-trpc-browser-api); these routes stay for REST
 * consumers outside the web client.
 */

import type { UpdateProfileRequest } from '@funny/shared';
import { Hono, type Context } from 'hono';

import type { ServerEnv } from '../lib/types.js';
import { profilePort as port } from '../trpc/ports/profile.js';
import { answerJson } from '../trpc/reply.js';

export const profileRoutes = new Hono<ServerEnv>();

const userIdOf = (c: Context<ServerEnv>) => c.get('userId') as string;

/** Generate a temporary AssemblyAI streaming token (API key stays server-side) */
profileRoutes.get('/transcribe-token', (c) => answerJson(c, port.transcribeToken(userIdOf(c))));

/** Get current user's profile */
profileRoutes.get('/', (c) => answerJson(c, port.get(userIdOf(c))));

/** Update current user's profile */
profileRoutes.put('/', async (c) =>
  answerJson(c, port.update(userIdOf(c), await c.req.json<UpdateProfileRequest>())),
);

/** GET /setup-completed */
profileRoutes.get('/setup-completed', (c) => answerJson(c, port.setupCompleted(userIdOf(c))));

/** GET /runner-invite-token — get (or auto-create) the user's runner invite token */
profileRoutes.get('/runner-invite-token', (c) =>
  answerJson(c, port.runnerInviteToken(userIdOf(c))),
);

/** POST /runner-invite-token/rotate — regenerate the runner invite token */
profileRoutes.post('/runner-invite-token/rotate', (c) =>
  answerJson(c, port.rotateRunnerInviteToken(userIdOf(c))),
);
