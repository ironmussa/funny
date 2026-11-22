/**
 * @domain subdomain: Git Operations
 * @domain subdomain-type: core
 * @domain type: pipeline-helpers
 * @domain layer: application
 *
 * Small helpers shared by the git pipeline nodes: turning a git-service
 * error into a thrown `Error`, tracking a node's progress step, resolving
 * the parent thread's working directory and committing a helper agent's fix.
 */
import type { GitWorkflowProgressStep } from '@funny/shared';
import type { Result } from 'neverthrow';

import { commitChanges as gitServiceCommit } from '../git-service.js';
import { getServices } from '../service-registry.js';
import * as tm from '../thread-manager.js';
import type { GitPipelineContext } from './context.js';

interface GitServiceError {
  type: string;
  message: string;
  stderr?: string;
}

/** The message a git-service error shows: git's stderr for a process error. */
export function gitErrorMessage(e: GitServiceError): string {
  return e.type === 'PROCESS_ERROR' ? e.stderr || e.message : e.message;
}

/** Return the value of a git-service result, or throw its message. */
export function unwrapGit<T>(result: Result<T, GitServiceError>): T {
  if (result.isErr()) throw new Error(gitErrorMessage(result.error));
  return result.value;
}

/**
 * Run a node's work as one progress step: mark it running, then completed
 * (with whatever `run` returns, e.g. a PR url), or failed with the error's
 * message (`fallback` when it has none) and rethrow.
 */
export async function trackStep(
  ctx: GitPipelineContext,
  stepId: string,
  fallback: string,
  run: () => Promise<Partial<GitWorkflowProgressStep> | void>,
): Promise<void> {
  ctx.setStep(stepId, { status: 'running' });
  let completion: Partial<GitWorkflowProgressStep> | void;
  try {
    completion = await run();
  } catch (e: any) {
    const message = e.message || fallback;
    ctx.setStep(stepId, { status: 'failed', error: message });
    throw new Error(message, { cause: e });
  }
  ctx.setStep(stepId, { status: 'completed', ...completion });
}

/** The parent thread's working directory, else the project's path, else the workflow's cwd. */
export async function resolveParentCwd(ctx: GitPipelineContext): Promise<string> {
  const parentThread = ctx.threadId ? await tm.getThread(ctx.threadId) : null;
  const parentCwd = parentThread?.worktreePath || parentThread?.initCwd;
  const project = ctx.projectId ? await getServices().projects.getProject(ctx.projectId) : null;
  return parentCwd || project?.path || ctx.cwd;
}

/** Commit a helper agent's changes on the parent thread as a pipeline commit (hooks skipped). */
export async function commitPipelineFix(
  ctx: GitPipelineContext & { threadId: string },
  cwd: string,
  message: string,
): Promise<{ sha?: string }> {
  return unwrapGit(
    await gitServiceCommit(ctx.threadId, ctx.userId, cwd, message, false, true, ctx.workflowId),
  );
}
