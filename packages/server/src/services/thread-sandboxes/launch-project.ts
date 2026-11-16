/**
 * @domain subdomain: Runner Infrastructure
 * @domain subdomain-type: supporting
 * @domain type: application-service
 * @domain layer: application
 *
 * The project a caller may start a sandbox thread on. Starting a thread needs
 * `steer` on the project — the same capability as any other thread start —
 * decided by `decideProjectAccess` with the server's role resolver, so a viewer
 * (an org share, or the viewer row `setMemberLocalPath` writes) is refused.
 */
import { eq } from 'drizzle-orm';

import { db } from '../../db/index.js';
import { projects } from '../../db/schema.js';
import { projectRole } from '../../lib/server-authorizer.js';
import { decideProjectAccess } from '../../middleware/project-access.js';

/** The project's path, `{ refused: 403 }` for a role without `steer`, or null when unseen. */
export async function findLaunchableProject(
  userId: string,
  projectId: string,
): Promise<{ path: string } | { refused: 403 } | null> {
  const refused = await decideProjectAccess(projectRole, 'steer', projectId, userId);
  if (refused) return refused.status === 404 ? null : { refused: 403 };
  const [row] = await db
    .select({ path: projects.path })
    .from(projects)
    .where(eq(projects.id, projectId));
  return row ? { path: row.path } : null;
}
