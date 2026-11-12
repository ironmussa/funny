import { failure, type ApiFailure } from '@funny/api';
import { err, ok, type Result } from 'neverthrow';

import { authorizer } from '../../lib/server-authorizer.js';

/**
 * A resource that acts on a project with its creator's identity (an automation
 * run, a pipeline review) requires that the creator can see that project, with
 * the same 404 as a missing project.
 */
export async function requireVisibleProject(
  userId: string,
  projectId: string,
): Promise<Result<void, ApiFailure>> {
  return (await authorizer.authorize(userId, 'project', projectId, 'view'))
    ? ok(undefined)
    : err(failure(404, 'Project not found'));
}
