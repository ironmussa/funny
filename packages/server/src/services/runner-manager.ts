/**
 * @domain subdomain: Runner Management
 * @domain subdomain-type: supporting
 * @domain type: app-service
 * @domain layer: application
 *
 * Manages registered runners — registration, heartbeat, task dispatch,
 * project assignment, and status tracking.
 *
 * Runners are project-agnostic machines. The admin assigns projects to
 * runners via the API, specifying the local path on the runner machine
 * where the repo lives. When dispatching tasks, the server uses this
 * mapping to resolve the correct cwd.
 */

import type {
  RunnerInfo,
  RunnerRegisterRequest,
  RunnerRegisterResponse,
  RunnerHeartbeatRequest,
  RunnerTask,
  RunnerTaskPayload,
  RunnerTaskResultRequest,
  RunnerProjectAssignment,
  AssignProjectRequest,
  UnassignProjectRequest,
} from '@funny/shared/runner-protocol';
import { eq, and } from 'drizzle-orm';
import { nanoid } from 'nanoid';

import { db } from '../db/index.js';
import { runners, runnerTasks, runnerProjectAssignments } from '../db/schema.js';
import { log } from '../lib/logger.js';

const HEARTBEAT_TIMEOUT_MS = 60_000; // Mark offline after 60s without heartbeat

// ── Registration ────────────────────────────────────────

export async function registerRunner(req: RunnerRegisterRequest): Promise<RunnerRegisterResponse> {
  const runnerId = nanoid();
  const token = `runner_${nanoid(32)}`;
  const now = new Date().toISOString();

  await db.insert(runners).values({
    id: runnerId,
    name: req.name,
    hostname: req.hostname,
    token,
    status: 'online',
    os: req.os,
    workspace: req.workspace ?? null,
    activeThreadIds: '[]',
    registeredAt: now,
    lastHeartbeatAt: now,
  });

  log.info('Runner registered', {
    namespace: 'runner',
    runnerId,
    name: req.name,
    hostname: req.hostname,
    os: req.os,
  });

  return { runnerId, token };
}

// ── Authentication ──────────────────────────────────────

export async function authenticateRunner(token: string): Promise<string | null> {
  const rows = await db.select({ id: runners.id }).from(runners).where(eq(runners.token, token));
  return rows[0]?.id ?? null;
}

// ── Heartbeat ───────────────────────────────────────────

export async function handleHeartbeat(
  runnerId: string,
  req: RunnerHeartbeatRequest,
): Promise<void> {
  const now = new Date().toISOString();
  const activeCount = req.activeThreadIds.length;

  await db
    .update(runners)
    .set({
      status: activeCount > 0 ? 'busy' : 'online',
      activeThreadIds: JSON.stringify(req.activeThreadIds),
      lastHeartbeatAt: now,
    })
    .where(eq(runners.id, runnerId));
}

// ── Runner Listing ──────────────────────────────────────

export async function listRunners(): Promise<RunnerInfo[]> {
  const rows = await db.select().from(runners);
  const now = Date.now();

  // Fetch all assignments to include in runner info
  const allAssignments = await db.select().from(runnerProjectAssignments);
  const assignmentsByRunner = new Map<string, string[]>();
  for (const a of allAssignments) {
    const list = assignmentsByRunner.get(a.runnerId) ?? [];
    list.push(a.projectId);
    assignmentsByRunner.set(a.runnerId, list);
  }

  return rows.map((r) => {
    // Auto-mark as offline if no heartbeat within timeout
    const lastHb = new Date(r.lastHeartbeatAt).getTime();
    const isStale = now - lastHb > HEARTBEAT_TIMEOUT_MS;
    const status = isStale ? 'offline' : (r.status as RunnerInfo['status']);

    return {
      runnerId: r.id,
      name: r.name,
      hostname: r.hostname,
      os: r.os,
      workspace: r.workspace ?? undefined,
      status,
      activeThreadCount: (JSON.parse(r.activeThreadIds) as string[]).length,
      assignedProjectIds: assignmentsByRunner.get(r.id) ?? [],
      registeredAt: r.registeredAt,
      lastHeartbeatAt: r.lastHeartbeatAt,
    };
  });
}

export async function getRunner(runnerId: string): Promise<RunnerInfo | null> {
  const rows = await db.select().from(runners).where(eq(runners.id, runnerId));
  if (!rows[0]) return null;
  const r = rows[0];

  const assignments = await db
    .select({ projectId: runnerProjectAssignments.projectId })
    .from(runnerProjectAssignments)
    .where(eq(runnerProjectAssignments.runnerId, runnerId));

  return {
    runnerId: r.id,
    name: r.name,
    hostname: r.hostname,
    os: r.os,
    workspace: r.workspace ?? undefined,
    status: r.status as RunnerInfo['status'],
    activeThreadCount: (JSON.parse(r.activeThreadIds) as string[]).length,
    assignedProjectIds: assignments.map((a) => a.projectId),
    registeredAt: r.registeredAt,
    lastHeartbeatAt: r.lastHeartbeatAt,
  };
}

// ── Project Assignment ──────────────────────────────────

/**
 * Assign a project to a runner with its local path on the runner machine.
 */
export async function assignProject(
  runnerId: string,
  req: AssignProjectRequest,
): Promise<RunnerProjectAssignment> {
  const now = new Date().toISOString();

  // Upsert: if already assigned, update the local path
  await db
    .insert(runnerProjectAssignments)
    .values({
      runnerId,
      projectId: req.projectId,
      localPath: req.localPath,
      assignedAt: now,
    })
    .onConflictDoUpdate({
      target: [runnerProjectAssignments.runnerId, runnerProjectAssignments.projectId],
      set: { localPath: req.localPath, assignedAt: now },
    });

  log.info('Project assigned to runner', {
    namespace: 'runner',
    runnerId,
    projectId: req.projectId,
    localPath: req.localPath,
  });

  return {
    runnerId,
    projectId: req.projectId,
    localPath: req.localPath,
    assignedAt: now,
  };
}

/**
 * Unassign a project from a runner.
 */
export async function unassignProject(
  runnerId: string,
  req: UnassignProjectRequest,
): Promise<void> {
  await db
    .delete(runnerProjectAssignments)
    .where(
      and(
        eq(runnerProjectAssignments.runnerId, runnerId),
        eq(runnerProjectAssignments.projectId, req.projectId),
      ),
    );

  log.info('Project unassigned from runner', {
    namespace: 'runner',
    runnerId,
    projectId: req.projectId,
  });
}

/**
 * List all project assignments for a runner.
 */
export async function listAssignments(runnerId: string): Promise<RunnerProjectAssignment[]> {
  const rows = await db
    .select()
    .from(runnerProjectAssignments)
    .where(eq(runnerProjectAssignments.runnerId, runnerId));

  return rows.map((r) => ({
    runnerId: r.runnerId,
    projectId: r.projectId,
    localPath: r.localPath,
    assignedAt: r.assignedAt,
  }));
}

// ── Task Dispatch ───────────────────────────────────────

/**
 * Find the best runner for a given project.
 * Uses the runner_project_assignments table to match projects to runners.
 * Returns the runner and its local path for the project.
 */
export async function findRunnerForProject(
  projectId: string,
): Promise<{ runner: RunnerInfo; localPath: string } | null> {
  // Find all assignments for this project
  const assignments = await db
    .select()
    .from(runnerProjectAssignments)
    .where(eq(runnerProjectAssignments.projectId, projectId));

  if (assignments.length === 0) return null;

  // Get the corresponding runners
  const allRunners = await listRunners();
  const runnerMap = new Map(allRunners.map((r) => [r.runnerId, r]));

  // Filter to online/busy runners with this assignment
  const candidates = assignments
    .map((a) => ({
      assignment: a,
      runner: runnerMap.get(a.runnerId),
    }))
    .filter(
      (c): c is { assignment: (typeof assignments)[0]; runner: RunnerInfo } =>
        c.runner != null && c.runner.status !== 'offline',
    );

  if (candidates.length === 0) return null;

  // Prefer online (idle) runners, then by fewest active threads
  candidates.sort((a, b) => {
    if (a.runner.status === 'online' && b.runner.status !== 'online') return -1;
    if (b.runner.status === 'online' && a.runner.status !== 'online') return 1;
    return a.runner.activeThreadCount - b.runner.activeThreadCount;
  });

  const best = candidates[0];
  return { runner: best.runner, localPath: best.assignment.localPath };
}

/**
 * Create a task for a runner and return it.
 */
export async function createRunnerTask(
  runnerId: string,
  threadId: string,
  type: RunnerTask['type'],
  payload: RunnerTaskPayload,
): Promise<RunnerTask> {
  const taskId = nanoid();
  const now = new Date().toISOString();

  await db.insert(runnerTasks).values({
    id: taskId,
    runnerId,
    type,
    threadId,
    payload: JSON.stringify(payload),
    status: 'pending',
    createdAt: now,
  });

  return {
    taskId,
    type,
    threadId,
    payload,
    createdAt: now,
  };
}

/**
 * Get pending tasks for a runner.
 */
export async function getPendingTasks(runnerId: string): Promise<RunnerTask[]> {
  const rows = await db
    .select()
    .from(runnerTasks)
    .where(and(eq(runnerTasks.runnerId, runnerId), eq(runnerTasks.status, 'pending')));

  // Mark as running
  for (const row of rows) {
    await db.update(runnerTasks).set({ status: 'running' }).where(eq(runnerTasks.id, row.id));
  }

  return rows.map((r) => ({
    taskId: r.id,
    type: r.type as RunnerTask['type'],
    threadId: r.threadId,
    payload: JSON.parse(r.payload) as RunnerTaskPayload,
    createdAt: r.createdAt,
  }));
}

/**
 * Record the result of a completed task.
 */
export async function completeTask(req: RunnerTaskResultRequest): Promise<void> {
  const now = new Date().toISOString();
  await db
    .update(runnerTasks)
    .set({
      status: req.success ? 'completed' : 'failed',
      resultData: req.data ? JSON.stringify(req.data) : null,
      resultError: req.error ?? null,
      completedAt: now,
    })
    .where(eq(runnerTasks.id, req.taskId));
}

// ── Cleanup ─────────────────────────────────────────────

export async function removeRunner(runnerId: string): Promise<void> {
  await db.delete(runners).where(eq(runners.id, runnerId));
  log.info('Runner removed', { namespace: 'runner', runnerId });
}
