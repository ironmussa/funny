/**
 * Runner management service for the central server.
 * Handles registration, heartbeat, task dispatch, and project assignments.
 */

import type {
  AdvertisedProvider,
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
import { eq, and, lt, or, isNull, inArray } from 'drizzle-orm';
import { nanoid } from 'nanoid';

import { db } from '../db/index.js';
import { runners, runnerTasks, runnerProjectAssignments } from '../db/schema.js';
import { log } from '../lib/logger.js';

const HEARTBEAT_TIMEOUT_MS = 60_000;

// ── Per-runner advertised providers (provider-manifest-loader §3.2) ──────────
// External providers a runner installed, advertised on register + heartbeat.
// In-memory: re-sent on every heartbeat, so a server restart self-heals within
// one heartbeat cycle. Keyed by runnerId; only the public face is stored (the
// runner keeps spawn/quirks local).
const advertisedByRunner = new Map<string, AdvertisedProvider[]>();

/** Record (or clear) the providers a runner advertised. */
export function setAdvertisedProviders(
  runnerId: string,
  providers: AdvertisedProvider[] | undefined,
): void {
  if (providers && providers.length > 0) advertisedByRunner.set(runnerId, providers);
  else advertisedByRunner.delete(runnerId);
}

/** Providers advertised by a specific runner. */
export function getAdvertisedProviders(runnerId: string): AdvertisedProvider[] {
  return advertisedByRunner.get(runnerId) ?? [];
}

/**
 * Providers advertised by the user's online runner. Per-runner by design — two
 * users with different runners see different provider sets (same as model
 * discovery). Returns [] when the user has no online runner.
 */
export async function getAdvertisedProvidersForUser(
  userId: string,
): Promise<AdvertisedProvider[]> {
  const runnerId = await findAnyRunnerForUser(userId);
  return runnerId ? getAdvertisedProviders(runnerId) : [];
}

// ── Active built-in ACP providers (lean-core §3) ────────────────────────────
// The built-in ACP providers a runner currently has active (may be trimmed via
// FUNNY_PROVIDERS). The client hides inactive built-ins from the picker.
// `null` = the runner didn't advertise a set (don't filter — no regression).
const activeBuiltinsByRunner = new Map<string, string[]>();

/** Record (or clear) the active built-in set a runner advertised. */
export function setActiveBuiltins(runnerId: string, ids: string[] | undefined): void {
  if (ids) activeBuiltinsByRunner.set(runnerId, ids);
  else activeBuiltinsByRunner.delete(runnerId);
}

/** The active built-in set for the user's online runner, or null if unknown. */
export async function getActiveBuiltinsForUser(userId: string): Promise<string[] | null> {
  const runnerId = await findAnyRunnerForUser(userId);
  if (!runnerId) return null;
  return activeBuiltinsByRunner.get(runnerId) ?? null;
}

/** Map a raw runner DB row to a RunnerInfo object. */
function toRunnerInfo(
  r: typeof runners.$inferSelect,
  assignedProjectIds: string[],
  now = Date.now(),
): RunnerInfo {
  const lastHb = new Date(r.lastHeartbeatAt).getTime();
  const isStale = now - lastHb > HEARTBEAT_TIMEOUT_MS;
  const status = isStale ? 'offline' : (r.status as RunnerInfo['status']);

  return {
    runnerId: r.id,
    name: r.name,
    hostname: r.hostname,
    os: r.os,
    workspace: r.workspace ?? undefined,
    httpUrl: r.httpUrl ?? undefined,
    status,
    activeThreadCount: (JSON.parse(r.activeThreadIds) as string[]).length,
    assignedProjectIds,
    registeredAt: r.registeredAt,
    lastHeartbeatAt: r.lastHeartbeatAt,
  };
}

// ── Registration ────────────────────────────────────────

export async function registerRunner(
  req: RunnerRegisterRequest,
  userId?: string,
): Promise<RunnerRegisterResponse> {
  const now = new Date().toISOString();

  // Check if a runner with the same hostname already exists — reuse it.
  // When userId is provided, match runners owned by this user OR runners
  // that were previously registered without a userId (will be backfilled).
  const existing = await db
    .select({ id: runners.id, token: runners.token })
    .from(runners)
    .where(
      userId
        ? and(
            eq(runners.hostname, req.hostname),
            or(eq(runners.userId, userId), isNull(runners.userId)),
          )
        : eq(runners.hostname, req.hostname),
    )
    .limit(1);

  if (existing.length > 0) {
    const runnerId = existing[0].id;
    const token = existing[0].token;

    // Update existing runner — mark online, refresh heartbeat.
    // Also update userId if provided (backfills runners registered without one).
    const updateFields: Record<string, any> = {
      name: req.name,
      status: 'online',
      os: req.os,
      httpUrl: req.httpUrl ?? null,
      lastHeartbeatAt: now,
    };
    if (userId) {
      updateFields.userId = userId;
    }
    await db.update(runners).set(updateFields).where(eq(runners.id, runnerId));

    log.info('Runner reconnected (reusing existing registration)', {
      namespace: 'runner',
      runnerId,
      hostname: req.hostname,
    });

    setAdvertisedProviders(runnerId, req.providers);
    setActiveBuiltins(runnerId, req.activeBuiltins);
    return { runnerId, token };
  }

  // New runner — create fresh registration
  const runnerId = nanoid();
  const token = `runner_${nanoid(32)}`;

  await db.insert(runners).values({
    id: runnerId,
    name: req.name,
    hostname: req.hostname,
    userId: userId ?? null,
    token,
    status: 'online',
    os: req.os,
    workspace: req.workspace ?? null,
    httpUrl: req.httpUrl ?? null,
    activeThreadIds: '[]',
    registeredAt: now,
    lastHeartbeatAt: now,
  });

  log.info('Runner registered', {
    namespace: 'runner',
    runnerId,
    name: req.name,
    hostname: req.hostname,
  });

  setAdvertisedProviders(runnerId, req.providers);
  setActiveBuiltins(runnerId, req.activeBuiltins);
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
): Promise<boolean> {
  // Verify runner still exists (may have been purged on server restart)
  const exists = await db
    .select({ id: runners.id })
    .from(runners)
    .where(eq(runners.id, runnerId))
    .limit(1);

  if (exists.length === 0) {
    return false;
  }

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

  setAdvertisedProviders(runnerId, req.providers);
  setActiveBuiltins(runnerId, req.activeBuiltins);
  return true;
}

// ── Runner Listing ──────────────────────────────────────

export async function listRunners(): Promise<RunnerInfo[]> {
  const rows = await db.select().from(runners);
  const now = Date.now();

  const allAssignments = await db.select().from(runnerProjectAssignments);

  const assignmentsByRunner = new Map<string, string[]>();
  for (const a of allAssignments) {
    const list = assignmentsByRunner.get(a.runnerId) ?? [];
    list.push(a.projectId);
    assignmentsByRunner.set(a.runnerId, list);
  }

  return rows.map((r) => toRunnerInfo(r, assignmentsByRunner.get(r.id) ?? [], now));
}

export async function getRunner(runnerId: string): Promise<RunnerInfo | null> {
  const rows = await db.select().from(runners).where(eq(runners.id, runnerId));
  if (!rows[0]) return null;

  const assignments = await db
    .select({ projectId: runnerProjectAssignments.projectId })
    .from(runnerProjectAssignments)
    .where(eq(runnerProjectAssignments.runnerId, runnerId));

  return toRunnerInfo(
    rows[0],
    assignments.map((a) => a.projectId),
  );
}

/**
 * Return the owning user ID for a runner (raw DB column).
 *
 * Unlike {@link getRunner}, this exposes the `userId` column that `RunnerInfo`
 * intentionally hides — used by tenant-isolation checks in the Socket.IO and
 * data-handler layers to reject cross-tenant requests from a compromised or
 * misconfigured runner. Returns `null` when the runner has no owner (legacy
 * rows pre-dating per-user runners).
 */
export async function getRunnerUserId(runnerId: string): Promise<string | null> {
  const rows = await db
    .select({ userId: runners.userId })
    .from(runners)
    .where(eq(runners.id, runnerId))
    .limit(1);
  return rows[0]?.userId ?? null;
}

// ── Project Assignment ──────────────────────────────────

export async function assignProject(
  runnerId: string,
  req: AssignProjectRequest,
): Promise<RunnerProjectAssignment> {
  const now = new Date().toISOString();

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

  return { runnerId, projectId: req.projectId, localPath: req.localPath, assignedAt: now };
}

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
}

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
 * Return the runnerId of any online runner owned by `userId`.
 *
 * Used by no-projectId fallbacks (e.g. `pty:list`) that still must not
 * cross tenant boundaries. Returns `null` when the user has no connected
 * runner — callers must NOT fall back to another user's runner.
 */
export async function findAnyRunnerForUser(userId: string): Promise<string | null> {
  const rows = await db.select({ id: runners.id }).from(runners).where(eq(runners.userId, userId));
  if (rows.length === 0) return null;

  const allRunners = await listRunners();
  const statusById = new Map(allRunners.map((r) => [r.runnerId, r]));

  const candidates = rows
    .map((r) => statusById.get(r.id))
    .filter((r): r is RunnerInfo => r != null && r.status !== 'offline');

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    if (a.status === 'online' && b.status !== 'online') return -1;
    if (b.status === 'online' && a.status !== 'online') return 1;
    return a.activeThreadCount - b.activeThreadCount;
  });

  return candidates[0].runnerId;
}

/**
 * Resolve a runner for a project while enforcing tenant isolation.
 *
 * When `userId` is provided, only returns a runner whose `runners.userId`
 * matches — preventing browser sockets from routing PTY/agent traffic to
 * another user's runner (which has access to a different local $HOME, git
 * credentials, etc). Callers that already validated the project ownership
 * upstream may omit `userId`, but every browser-originated path should pass
 * it.
 */
export async function findRunnerForProject(
  projectId: string,
  userId?: string,
): Promise<{ runner: RunnerInfo; localPath: string } | null> {
  const assignments = await db
    .select()
    .from(runnerProjectAssignments)
    .where(eq(runnerProjectAssignments.projectId, projectId));

  if (assignments.length === 0) return null;

  let allowedRunnerIds: Set<string> | null = null;
  if (userId) {
    const ownedRows = await db
      .select({ id: runners.id })
      .from(runners)
      .where(eq(runners.userId, userId));
    allowedRunnerIds = new Set(ownedRows.map((r) => r.id));
    if (allowedRunnerIds.size === 0) return null;
  }

  const allRunners = await listRunners();
  const runnerMap = new Map(allRunners.map((r) => [r.runnerId, r]));

  const candidates = assignments
    .map((a) => ({ assignment: a, runner: runnerMap.get(a.runnerId) }))
    .filter(
      (c): c is { assignment: (typeof assignments)[0]; runner: RunnerInfo } =>
        c.runner != null &&
        c.runner.status !== 'offline' &&
        (allowedRunnerIds == null || allowedRunnerIds.has(c.runner.runnerId)),
    );

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    if (a.runner.status === 'online' && b.runner.status !== 'online') return -1;
    if (b.runner.status === 'online' && a.runner.status !== 'online') return 1;
    return a.runner.activeThreadCount - b.runner.activeThreadCount;
  });

  const best = candidates[0];
  return { runner: best.runner, localPath: best.assignment.localPath };
}

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

  return { taskId, type, threadId, payload, createdAt: now };
}

export async function getPendingTasks(runnerId: string): Promise<RunnerTask[]> {
  const rows = await db
    .select()
    .from(runnerTasks)
    .where(and(eq(runnerTasks.runnerId, runnerId), eq(runnerTasks.status, 'pending')));

  if (rows.length > 0) {
    const ids = rows.map((r) => r.id);
    await db.update(runnerTasks).set({ status: 'running' }).where(inArray(runnerTasks.id, ids));
  }

  return rows.map((r) => ({
    taskId: r.id,
    type: r.type as RunnerTask['type'],
    threadId: r.threadId,
    payload: JSON.parse(r.payload) as RunnerTaskPayload,
    createdAt: r.createdAt,
  }));
}

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

export async function getRunnerHttpUrl(runnerId: string): Promise<string | null> {
  const rows = await db
    .select({ httpUrl: runners.httpUrl })
    .from(runners)
    .where(eq(runners.id, runnerId));
  return rows[0]?.httpUrl ?? null;
}

export async function removeRunner(runnerId: string): Promise<void> {
  await db.delete(runnerProjectAssignments).where(eq(runnerProjectAssignments.runnerId, runnerId));
  await db.delete(runners).where(eq(runners.id, runnerId));
  log.info('Runner removed', { namespace: 'runner', runnerId });
}

/** Remove all runners that have been offline longer than the given threshold. */
export async function purgeOfflineRunners(olderThanMs = 60_000): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  const stale = await db
    .select({ id: runners.id })
    .from(runners)
    .where(and(eq(runners.status, 'offline'), lt(runners.lastHeartbeatAt, cutoff)));

  const staleIds = stale.map((r) => r.id);
  await db
    .delete(runnerProjectAssignments)
    .where(inArray(runnerProjectAssignments.runnerId, staleIds));
  await db.delete(runners).where(inArray(runners.id, staleIds));

  if (stale.length > 0) {
    log.info(`Purged ${stale.length} stale offline runner(s)`, { namespace: 'runner' });
  }
  return stale.length;
}

/**
 * Mark ALL runners as offline on server startup.
 * After a restart no runner has an active WebSocket, so mark them offline.
 * Runners will re-register via heartbeat and re-establish their WS tunnel.
 * We keep the runner records (and project assignments) so that the proxy can
 * use httpUrl fallback while the runner reconnects, avoiding 502 errors
 * during the restart window.
 */
export async function purgeAllRunners(): Promise<void> {
  await db.update(runners).set({ status: 'offline' });
  // Clear pending tasks — they're stale after a restart
  await db.delete(runnerTasks);
  log.info('Marked all runners offline (server restart)', {
    namespace: 'runner',
  });
}

/**
 * Mark a single runner as offline when its WebSocket disconnects.
 * This prevents the resolver from routing requests to a runner
 * that is no longer reachable via tunnel.
 */
export async function markRunnerOffline(runnerId: string): Promise<void> {
  await db.update(runners).set({ status: 'offline' }).where(eq(runners.id, runnerId));
  log.info('Runner marked offline (WS disconnected)', { namespace: 'runner', runnerId });
}

/**
 * Mark ALL runners as offline on server startup.
 * When the server restarts, no runner has an active WebSocket connection,
 * so any "online" status from a previous session is stale.
 */
export async function markAllRunnersOffline(): Promise<void> {
  await db.update(runners).set({ status: 'offline', lastHeartbeatAt: new Date().toISOString() });
  log.info('Marked all runners offline (server restart)', { namespace: 'runner' });
}

/**
 * Delete runners that haven't sent a heartbeat in 24 hours.
 * Prevents hostname-match from reusing stale runner records.
 */
export async function purgeStaleRunners(): Promise<void> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const stale = await db
    .select({ id: runners.id })
    .from(runners)
    .where(lt(runners.lastHeartbeatAt, cutoff));

  if (stale.length === 0) return;

  const staleIds = stale.map((r) => r.id);
  await db
    .delete(runnerProjectAssignments)
    .where(inArray(runnerProjectAssignments.runnerId, staleIds));
  await db.delete(runners).where(inArray(runners.id, staleIds));
  log.info(`Purged ${staleIds.length} stale runner(s)`, { namespace: 'runner' });
}

/** List only the runners owned by a specific user. */
export async function listRunnersByUser(userId: string): Promise<RunnerInfo[]> {
  const rows = await db.select().from(runners).where(eq(runners.userId, userId));
  if (rows.length === 0) return [];

  const now = Date.now();
  const runnerIds = rows.map((r) => r.id);
  const userAssignments = await db
    .select()
    .from(runnerProjectAssignments)
    .where(inArray(runnerProjectAssignments.runnerId, runnerIds));

  const assignmentsByRunner = new Map<string, string[]>();
  for (const a of userAssignments) {
    const list = assignmentsByRunner.get(a.runnerId) ?? [];
    list.push(a.projectId);
    assignmentsByRunner.set(a.runnerId, list);
  }

  return rows.map((r) => toRunnerInfo(r, assignmentsByRunner.get(r.id) ?? [], now));
}

/** Delete a runner only if it belongs to the requesting user. Returns false if not found/owned. */
export async function removeRunnerForUser(runnerId: string, userId: string): Promise<boolean> {
  const rows = await db
    .select({ id: runners.id })
    .from(runners)
    .where(and(eq(runners.id, runnerId), eq(runners.userId, userId)));

  if (!rows[0]) return false;

  await db.delete(runners).where(eq(runners.id, runnerId));
  log.info('Runner removed by owner', { namespace: 'runner', runnerId, userId });
  return true;
}
