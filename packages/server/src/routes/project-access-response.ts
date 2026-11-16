/**
 * The HTTP answer for a per-(project, user) settings service that refused the
 * caller at the project-access gate (`services/project-access.ts`): no role on
 * the project is a 404, a role without the capability is a 403.
 */
import type { Context } from 'hono';

import type { ServerEnv } from '../lib/types.js';

export function projectAccessRefusal(
  c: Context<ServerEnv>,
  error: { kind: 'not-found' | 'forbidden'; message: string },
) {
  return c.json({ error: error.message, code: error.kind }, error.kind === 'not-found' ? 404 : 403);
}
