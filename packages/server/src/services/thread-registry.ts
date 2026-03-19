/**
 * Thread registry for the central server.
 * Tracks which thread lives on which runner, plus lightweight metadata
 * for routing and listing.
 */

import { and, eq } from 'drizzle-orm';

import { db } from '../db/index.js';
import { threads, runners } from '../db/schema.js';
import { log } from '../lib/logger.js';

export interface ThreadEntry {
  id: string;
  projectId: string | null;
  runnerId: string | null;
  userId: string;
  title: string | null;
  status: string;
  stage: string;
  model: string | null;
  mode: string | null;
  branch: string | null;
  createdAt: string;
  completedAt: string | null;
}

/**
 * Register a thread in the central DB.
 * Called when a thread is created via the server proxy.
 */
export async function registerThread(entry: {
  id: string;
  projectId: string;
  runnerId: string;
  userId: string;
  title?: string;
  model?: string;
  mode?: string;
  branch?: string;
}): Promise<void> {
  const now = new Date().toISOString();

  await db
    .insert(threads)
    .values({
      id: entry.id,
      projectId: entry.projectId,
      runnerId: entry.runnerId,
      userId: entry.userId,
      title: entry.title ?? null,
      status: 'idle',
      stage: 'backlog',
      model: entry.model ?? null,
      mode: entry.mode ?? null,
      branch: entry.branch ?? null,
      createdAt: now,
    })
    .onConflictDoUpdate({
      target: [threads.id],
      set: {
        runnerId: entry.runnerId,
        title: entry.title ?? null,
        model: entry.model ?? null,
        mode: entry.mode ?? null,
        branch: entry.branch ?? null,
      },
    });

  log.info('Thread registered', {
    namespace: 'thread-registry',
    threadId: entry.id,
    projectId: entry.projectId,
    runnerId: entry.runnerId,
  });
}

/**
 * Get the runner ID and httpUrl for a thread, scoped to the requesting user.
 * Returns null if the thread has no runner, the runner doesn't belong to the user,
 * or the runner no longer exists.
 */
export async function getRunnerForThread(
  threadId: string,
  userId: string,
): Promise<{ runnerId: string; httpUrl: string | null } | null> {
  const rows = await db
    .select({
      runnerId: threads.runnerId,
      httpUrl: runners.httpUrl,
    })
    .from(threads)
    .innerJoin(runners, eq(runners.id, threads.runnerId))
    .where(and(eq(threads.id, threadId), eq(runners.userId, userId)));

  const row = rows[0];
  if (!row || !row.runnerId) return null;

  return {
    runnerId: row.runnerId,
    httpUrl: row.httpUrl ?? null,
  };
}

/**
 * Update thread status (called when runner reports agent status changes).
 */
export async function updateThreadStatus(
  threadId: string,
  status: string,
  stage?: string,
): Promise<void> {
  const updates: Record<string, unknown> = { status };
  if (stage) updates.stage = stage;
  if (status === 'completed' || status === 'error') {
    updates.completedAt = new Date().toISOString();
  }

  await db.update(threads).set(updates).where(eq(threads.id, threadId));
}

/**
 * List threads for a project (lightweight metadata only).
 */
export async function listThreadsForProject(
  projectId: string,
  _userId?: string,
): Promise<ThreadEntry[]> {
  let query = db.select().from(threads).where(eq(threads.projectId, projectId));

  const rows = await query;

  return rows.map((r) => ({
    id: r.id,
    projectId: r.projectId,
    runnerId: r.runnerId,
    userId: r.userId,
    title: r.title,
    status: r.status,
    stage: r.stage,
    model: r.model,
    mode: r.mode,
    branch: r.branch,
    createdAt: r.createdAt,
    completedAt: r.completedAt,
  }));
}

/**
 * Remove a thread from the registry.
 */
export async function unregisterThread(threadId: string): Promise<void> {
  await db.delete(threads).where(eq(threads.id, threadId));
}
