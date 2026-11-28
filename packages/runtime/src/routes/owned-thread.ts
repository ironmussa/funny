/**
 * What the thread-scoped runner routes share (`regression-proof`,
 * `factory-steps`, `factory-flow-setup`): the caller's own thread, a refusal
 * answered as `{ error, code }`, and the path of the thread's project.
 */

import type { DomainError } from '@funny/shared/errors';
import type { Context } from 'hono';
import { err } from 'neverthrow';
import type { z } from 'zod';

import type { HonoEnv } from '../types/hono-env.js';
import { resultToResponse } from '../utils/result-response.js';
import { requireProject, requireThread } from '../utils/route-helpers.js';
import { validate } from '../validation/schemas.js';

export type OwnedThread = ReturnType<Awaited<ReturnType<typeof requireThread>>['_unsafeUnwrap']>;

export interface Refusal {
  error: string;
  code: string;
  status: 400 | 403 | 409;
}

export const refuse = (status: Refusal['status'], code: string, error: string): Refusal => ({
  error,
  code,
  status,
});

export const answerRefusal = (c: Context<HonoEnv>, refusal: Refusal): Response =>
  c.json({ error: refusal.error, code: refusal.code }, refusal.status);

/** Answer for the caller's own thread, or the 404 / 403 of `requireThread`. */
export async function withOwnedThread(
  c: Context<HonoEnv>,
  handle: (thread: OwnedThread) => Response | Promise<Response>,
): Promise<Response> {
  const threadResult = await requireThread(c.req.param('id') ?? '', c.get('userId'));
  if (threadResult.isErr()) return resultToResponse(c, threadResult);
  return handle(threadResult.value);
}

/**
 * The path of the thread's project as the caller can access it (a
 * collaborator's own checkout, else the project's path), or why there is none.
 */
export async function projectPathOf(
  thread: OwnedThread,
  userId: string,
  organizationId: string | null | undefined,
): Promise<Refusal | { projectPath: string } | { denied: DomainError }> {
  if (!thread.projectId) return refuse(400, 'no-project', 'Thread has no project');
  const project = await requireProject(thread.projectId, userId, organizationId);
  if (project.isErr()) return { denied: project.error };
  if (!project.value.path) return refuse(400, 'no-project', 'Thread has no project path');
  return { projectPath: project.value.path };
}

type ProjectLookup = Refusal | { projectPath: string } | { denied: DomainError };

/** Answer the project lookup's refusal, else read the body through `schema`, then `handle`. */
export async function withProjectAndBody<T>(
  c: Context<HonoEnv>,
  lookup: Promise<ProjectLookup>,
  schema: z.ZodType<T>,
  handle: (projectPath: string, body: T) => Response | Promise<Response>,
): Promise<Response> {
  const project = await lookup;
  if ('denied' in project) return resultToResponse(c, err(project.denied));
  if ('status' in project) return answerRefusal(c, project);
  const parsed = validate(schema, await c.req.json().catch(() => ({})));
  if (parsed.isErr()) return resultToResponse(c, parsed);
  return handle(project.projectPath, parsed.value);
}
