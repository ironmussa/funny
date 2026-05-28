/**
 * Pipeline CRUD + run tracking backed by the server's database.
 * Pure data operations only — pipeline execution lives in the runtime.
 */

import { and, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';

import { db, dbAll, dbGet, dbRun } from '../db/index.js';
import { pipelines, pipelineRuns, threads } from '../db/schema.js';

// ── Pipeline CRUD ────────────────────────────────────────────
//
// Security CR-5: every read/write here MUST be scoped to the caller's
// `userId`. The route layer previously trusted callers with bare ids and
// any logged-in user could read/mutate/delete another tenant's pipelines.
// Helpers accept `userId` as the second arg and return null/no-op when the
// row doesn't belong to that user. The `pipelines.userId` column is set
// at creation time (see `createPipeline`).

export async function getPipelineForProject(projectId: string, userId: string) {
  const rows = await dbAll(
    db
      .select()
      .from(pipelines)
      .where(and(eq(pipelines.projectId, projectId), eq(pipelines.userId, userId))),
  );
  return rows.find((r: any) => r.enabled) ?? null;
}

export async function createPipeline(data: {
  projectId: string;
  userId: string;
  name: string;
  reviewModel?: string;
  fixModel?: string;
  maxIterations?: number;
  precommitFixEnabled?: boolean;
  precommitFixModel?: string;
  precommitFixMaxIterations?: number;
  reviewerPrompt?: string;
  correctorPrompt?: string;
  precommitFixerPrompt?: string;
  commitMessagePrompt?: string;
  testEnabled?: boolean;
  testCommand?: string;
  testFixEnabled?: boolean;
  testFixModel?: string;
  testFixMaxIterations?: number;
  testFixerPrompt?: string;
}): Promise<string> {
  const id = nanoid();
  const now = new Date().toISOString();
  await dbRun(
    db.insert(pipelines).values({
      id,
      projectId: data.projectId,
      userId: data.userId,
      name: data.name,
      enabled: 1,
      reviewModel: data.reviewModel || 'sonnet',
      fixModel: data.fixModel || 'sonnet',
      maxIterations: data.maxIterations || 10,
      precommitFixEnabled: data.precommitFixEnabled ? 1 : 0,
      precommitFixModel: data.precommitFixModel || 'sonnet',
      precommitFixMaxIterations: data.precommitFixMaxIterations || 3,
      reviewerPrompt: data.reviewerPrompt || null,
      correctorPrompt: data.correctorPrompt || null,
      precommitFixerPrompt: data.precommitFixerPrompt || null,
      commitMessagePrompt: data.commitMessagePrompt || null,
      testEnabled: data.testEnabled ? 1 : 0,
      testCommand: data.testCommand || null,
      testFixEnabled: data.testFixEnabled ? 1 : 0,
      testFixModel: data.testFixModel || 'sonnet',
      testFixMaxIterations: data.testFixMaxIterations || 3,
      testFixerPrompt: data.testFixerPrompt || null,
      createdAt: now,
      updatedAt: now,
    }),
  );
  return id;
}

export async function getPipelineById(id: string, userId: string) {
  return dbGet(
    db
      .select()
      .from(pipelines)
      .where(and(eq(pipelines.id, id), eq(pipelines.userId, userId))),
  );
}

export async function getPipelinesByProject(projectId: string, userId: string) {
  return dbAll(
    db
      .select()
      .from(pipelines)
      .where(and(eq(pipelines.projectId, projectId), eq(pipelines.userId, userId))),
  );
}

export async function updatePipeline(id: string, userId: string, updates: Record<string, unknown>) {
  const data = { ...updates, updatedAt: new Date().toISOString() };
  await dbRun(
    db
      .update(pipelines)
      .set(data)
      .where(and(eq(pipelines.id, id), eq(pipelines.userId, userId))),
  );
}

export async function deletePipeline(id: string, userId: string) {
  await dbRun(db.delete(pipelines).where(and(eq(pipelines.id, id), eq(pipelines.userId, userId))));
}

// ── Pipeline Run CRUD ────────────────────────────────────────

export async function createRun(data: {
  pipelineId: string;
  threadId: string;
  maxIterations: number;
  commitSha?: string;
}): Promise<string> {
  const id = nanoid();
  await dbRun(
    db.insert(pipelineRuns).values({
      id,
      pipelineId: data.pipelineId,
      threadId: data.threadId,
      status: 'reviewing',
      currentStage: 'reviewer',
      iteration: 1,
      maxIterations: data.maxIterations,
      commitSha: data.commitSha,
      createdAt: new Date().toISOString(),
    }),
  );
  return id;
}

export async function updateRun(id: string, updates: Record<string, unknown>) {
  await dbRun(db.update(pipelineRuns).set(updates).where(eq(pipelineRuns.id, id)));
}

export async function getRunById(id: string) {
  return dbGet(db.select().from(pipelineRuns).where(eq(pipelineRuns.id, id)));
}

export async function getRunsForThread(threadId: string, userId: string) {
  // Security CR-5: pipeline_runs has no userId column. Verify ownership
  // through the parent thread before returning rows.
  const thread = await dbGet(
    db
      .select()
      .from(threads)
      .where(and(eq(threads.id, threadId), eq(threads.userId, userId))),
  );
  if (!thread) return [];
  return dbAll(db.select().from(pipelineRuns).where(eq(pipelineRuns.threadId, threadId)));
}
