/**
 * @domain subdomain: Automation
 * @domain subdomain-type: core
 * @domain type: app-service
 * @domain layer: application
 *
 * What an agent in a thread may do on the thread owner's automations behind
 * the runner's data channel:
 *
 * - list the owner's automations in the thread's project,
 * - create a new scheduled automation in the thread's project,
 * - update an existing automation in the thread's project (never moving it to
 *   another project),
 * - delete or manually trigger an automation in the thread's project.
 *
 * The actor is always the thread's owner as stored, and the project is always
 * the thread's project; the model cannot override either.
 */

import type { Automation } from '@funny/shared';
import { createAutomationBody, updateAutomationBody } from '@funny/shared/contracts/automations';
import { and, eq } from 'drizzle-orm';
import { err, ok, type Result } from 'neverthrow';
import { z } from 'zod';

import { db } from '../db/index.js';
import { threads, threadShares } from '../db/schema.js';
import { automationsPort } from '../trpc/ports/automations.js';
import { sandboxThreadOfRunner } from './runner-scope.js';

export type AutomationToolAction = 'list' | 'create' | 'update' | 'delete' | 'trigger';

type AutomationToolError = {
  kind: 'refused' | 'not-found' | 'invalid' | 'storage';
  message: string;
};

/** The thread fields the access decision reads. */
export interface AutomationToolThread {
  id: string;
  userId: string;
  projectId: string | null;
  isScratch: boolean;
  readOnly: boolean;
  runtime: string;
  source: string;
}

interface AutomationToolContext {
  threadId: string;
  runnerId: string;
  runnerOwnerId: string;
}

/**
 * Why `action` is refused from this thread, or null when it is allowed.
 *
 * The tools are for a thread whose input is its owner's: not a sandbox, not a
 * read-only thread, not a scratch/projectless thread, not a thread started by
 * the issue factory or by another automation (prevents self-modifying or
 * recursive automation loops), and, for mutations, not a thread someone else
 * may steer.
 */
export function automationToolAccess(
  thread: AutomationToolThread | null,
  action: AutomationToolAction,
  facts: { runnerOwnerId: string; sandboxRunner: boolean; steerShared: boolean },
): string | null {
  if (!thread) return 'Thread not found.';
  if (thread.userId !== facts.runnerOwnerId) return 'Thread not found.';
  if (facts.sandboxRunner || thread.runtime === 'sandbox') {
    return 'The automation tools are not available in a sandbox thread.';
  }
  if (thread.readOnly) return 'The automation tools are not available in a read-only thread.';
  if (thread.isScratch || !thread.projectId) {
    return 'The automation tools need a thread in a project.';
  }
  if (thread.source === 'factory') {
    return 'A thread the factory started cannot manage automations.';
  }
  if (thread.source === 'automation') {
    return 'A thread started by an automation cannot manage automations.';
  }
  if (action !== 'list' && facts.steerShared) {
    return 'This thread is shared for steering, so its agent can only list automations.';
  }
  return null;
}

/**
 * Strict allow-list for updates via the agent MCP channel: same as
 * `updateAutomationBody`, minus `projectId` so an agent can never move an
 * automation into another project.
 */
export const agentUpdateAutomationPatch = updateAutomationBody.omit({ projectId: true }).strict();

export const agentCreateAutomationInput = createAutomationBody.omit({ projectId: true });

type AgentCreateAutomationInput = z.output<typeof agentCreateAutomationInput>;
type AgentUpdateAutomationPatch = z.output<typeof agentUpdateAutomationPatch>;

function refusal(message: string): Result<never, AutomationToolError> {
  return err({ kind: 'refused', message });
}

function mapPortFailure(failure: {
  status: number;
  message: string;
  friendlyMessage?: string;
}): AutomationToolError {
  const message = failure.friendlyMessage ?? failure.message;
  if (failure.status === 404) return { kind: 'not-found', message };
  if (failure.status === 400) return { kind: 'invalid', message };
  if (failure.status === 403) return { kind: 'refused', message };
  return { kind: 'storage', message };
}

async function resolveAuthorizedThread(
  ctx: AutomationToolContext,
  action: AutomationToolAction,
): Promise<Result<{ userId: string; projectId: string }, AutomationToolError>> {
  const [row] = await db
    .select({
      id: threads.id,
      userId: threads.userId,
      projectId: threads.projectId,
      isScratch: threads.isScratch,
      readOnly: threads.readOnly,
      runtime: threads.runtime,
      source: threads.source,
    })
    .from(threads)
    .where(eq(threads.id, ctx.threadId));

  const thread: AutomationToolThread | null = row
    ? {
        id: row.id,
        userId: row.userId,
        projectId: row.projectId ?? null,
        isScratch: row.isScratch === 1,
        readOnly: row.readOnly === 1,
        runtime: row.runtime,
        source: row.source,
      }
    : null;

  const sandboxRunner = (await sandboxThreadOfRunner(ctx.runnerId)) !== null;
  let steerShared = false;
  if (thread && action !== 'list') {
    const shareRows = await db
      .select({ id: threadShares.threadId })
      .from(threadShares)
      .where(and(eq(threadShares.threadId, thread.id), eq(threadShares.level, 'steer')))
      .limit(1);
    steerShared = shareRows.length > 0;
  }

  const denied = automationToolAccess(thread, action, {
    runnerOwnerId: ctx.runnerOwnerId,
    sandboxRunner,
    steerShared,
  });
  if (denied) return refusal(denied);
  if (!thread || !thread.projectId) return refusal('Thread not found.');

  return ok({ userId: thread.userId, projectId: thread.projectId });
}

async function ensureAutomationInProject(
  userId: string,
  projectId: string,
  automationId: string,
): Promise<Result<Automation, AutomationToolError>> {
  const got = await automationsPort.get(userId, automationId);
  if (got.isErr()) return err(mapPortFailure(got.error));
  if (got.value.projectId !== projectId) {
    return err({ kind: 'not-found', message: 'Automation not found in this project.' });
  }
  return ok(got.value);
}

export const automationAgentTools = {
  async list(ctx: AutomationToolContext): Promise<Result<Automation[], AutomationToolError>> {
    const auth = await resolveAuthorizedThread(ctx, 'list');
    if (auth.isErr()) return err(auth.error);
    const listed = await automationsPort.list(auth.value.userId, {
      projectId: auth.value.projectId,
    });
    return listed.isOk() ? ok(listed.value) : err(mapPortFailure(listed.error));
  },

  async create(
    ctx: AutomationToolContext,
    input: AgentCreateAutomationInput,
  ): Promise<Result<Automation, AutomationToolError>> {
    const auth = await resolveAuthorizedThread(ctx, 'create');
    if (auth.isErr()) return err(auth.error);

    const created = await automationsPort.create(auth.value.userId, {
      ...input,
      projectId: auth.value.projectId,
    });
    return created.isOk() ? ok(created.value) : err(mapPortFailure(created.error));
  },

  async update(
    ctx: AutomationToolContext,
    automationId: string,
    patch: AgentUpdateAutomationPatch,
  ): Promise<Result<Automation, AutomationToolError>> {
    const auth = await resolveAuthorizedThread(ctx, 'update');
    if (auth.isErr()) return err(auth.error);

    const owned = await ensureAutomationInProject(
      auth.value.userId,
      auth.value.projectId,
      automationId,
    );
    if (owned.isErr()) return err(owned.error);

    const updated = await automationsPort.update(auth.value.userId, automationId, patch);
    return updated.isOk() ? ok(updated.value) : err(mapPortFailure(updated.error));
  },

  async remove(
    ctx: AutomationToolContext,
    automationId: string,
  ): Promise<Result<{ id: string; name: string }, AutomationToolError>> {
    const auth = await resolveAuthorizedThread(ctx, 'delete');
    if (auth.isErr()) return err(auth.error);

    const owned = await ensureAutomationInProject(
      auth.value.userId,
      auth.value.projectId,
      automationId,
    );
    if (owned.isErr()) return err(owned.error);

    const removed = await automationsPort.remove(auth.value.userId, automationId);
    if (removed.isErr()) return err(mapPortFailure(removed.error));
    return ok({ id: owned.value.id, name: owned.value.name });
  },

  async trigger(
    ctx: AutomationToolContext,
    automationId: string,
  ): Promise<Result<{ runId: string; threadId: string; name: string }, AutomationToolError>> {
    const auth = await resolveAuthorizedThread(ctx, 'trigger');
    if (auth.isErr()) return err(auth.error);

    const owned = await ensureAutomationInProject(
      auth.value.userId,
      auth.value.projectId,
      automationId,
    );
    if (owned.isErr()) return err(owned.error);

    const triggered = await automationsPort.trigger(auth.value.userId, automationId);
    if (triggered.isErr()) return err(mapPortFailure(triggered.error));
    return ok({
      runId: triggered.value.runId,
      threadId: triggered.value.threadId,
      name: owned.value.name,
    });
  },
};
