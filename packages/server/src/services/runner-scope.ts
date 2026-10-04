/**
 * @domain subdomain: Team Collaboration
 * @domain subdomain-type: supporting
 * @domain type: domain-service
 * @domain layer: application
 *
 * Runner scope (project-runner-binding): the single source of truth for WHICH
 * runner may serve WHICH project.
 *
 *   - A runner has a role: `general` (serves projectless work and every project
 *     without an override — today's behaviour) or `dedicated` (serves only the
 *     projects it is bound to).
 *   - A project uses its owner's general runner unless its settings select a
 *     dedicated runner. Extra runners may be granted access explicitly from the
 *     project's settings (`project_runner_grants`).
 *   - `runner_project_assignments` stays a LOCATION record (where the project
 *     lives on a runner's disk). Runners write it themselves, so it is never an
 *     authorization source.
 *
 * Every routing / data-channel / push decision about runner↔project access MUST
 * go through `canRunnerAccessProject` / `canRunnerServeProjectless` — never
 * re-derive the rule at a call site.
 */

import { and, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';

import { db } from '../db/index.js';
import {
  projectRunnerGrants,
  projectRunnerSettings,
  projects,
  runners,
  userProfiles,
} from '../db/schema.js';
import { decrypt, encrypt } from '../lib/crypto.js';
import { log } from '../lib/logger.js';

export type RunnerRole = 'general' | 'dedicated';

export interface RunnerScopeRecord {
  id: string;
  userId: string | null;
  role: RunnerRole;
}

export interface ProjectRunnerPolicy {
  projectId: string;
  ownerId: string;
  dedicatedRunnerId: string | null;
  grantedRunnerIds: string[];
}

// ── Pure rule ──────────────────────────────────────────────

/**
 * The access rule, free of I/O so it can be unit-tested exhaustively.
 *
 * Ownership/membership (does this runner's USER may touch the project?) is
 * checked separately by the callers; this only answers the runner-level
 * question.
 */
export function evaluateRunnerAccess(
  runner: RunnerScopeRecord,
  policy: ProjectRunnerPolicy,
): boolean {
  if (policy.dedicatedRunnerId === runner.id) return true;
  if (policy.grantedRunnerIds.includes(runner.id)) return true;
  if (runner.role === 'dedicated') return false;
  // A general runner serves the project unless the project's owner pinned it
  // to a dedicated runner. A collaborator's own general runner is unaffected
  // by the owner's override (it works from the collaborator's checkout).
  return !(policy.dedicatedRunnerId && runner.userId === policy.ownerId);
}

// ── Cache ──────────────────────────────────────────────────

const CACHE_TTL_MS = 30_000;
const runnerCache = new Map<string, { value: RunnerScopeRecord | null; at: number }>();
const policyCache = new Map<string, { value: ProjectRunnerPolicy | null; at: number }>();

function fresh<T>(entry: { value: T; at: number } | undefined): entry is { value: T; at: number } {
  return !!entry && Date.now() - entry.at < CACHE_TTL_MS;
}

type ScopeChangeListener = (change: { runnerId?: string; projectId?: string }) => void;
const listeners = new Set<ScopeChangeListener>();

/** Subscribe to scope changes (e.g. to evict routing caches). Returns unsubscribe. */
export function onRunnerScopeChange(listener: ScopeChangeListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Drop cached scope data. Must run synchronously in the request that changed it. */
export function invalidateRunnerScope(change: { runnerId?: string; projectId?: string } = {}) {
  if (change.runnerId) runnerCache.delete(change.runnerId);
  if (change.projectId) policyCache.delete(change.projectId);
  if (!change.runnerId && !change.projectId) {
    runnerCache.clear();
    policyCache.clear();
  }
  for (const listener of listeners) {
    try {
      listener(change);
    } catch (e) {
      log.warn('Runner scope listener failed', {
        namespace: 'runner-scope',
        error: (e as Error).message,
      });
    }
  }
}

/** Test helper. */
export function __resetRunnerScopeCache() {
  runnerCache.clear();
  policyCache.clear();
}

// ── Reads ──────────────────────────────────────────────────

export async function getRunnerScopeRecord(runnerId: string): Promise<RunnerScopeRecord | null> {
  const cached = runnerCache.get(runnerId);
  if (fresh(cached)) return cached.value;
  const [row] = await db
    .select({ id: runners.id, userId: runners.userId, role: runners.role })
    .from(runners)
    .where(eq(runners.id, runnerId));
  const value: RunnerScopeRecord | null = row
    ? {
        id: row.id,
        userId: row.userId,
        role: row.role === 'dedicated' ? 'dedicated' : 'general',
      }
    : null;
  runnerCache.set(runnerId, { value, at: Date.now() });
  return value;
}

export async function getProjectRunnerPolicy(
  projectId: string,
): Promise<ProjectRunnerPolicy | null> {
  const cached = policyCache.get(projectId);
  if (fresh(cached)) return cached.value;
  const [project] = await db
    .select({ id: projects.id, userId: projects.userId })
    .from(projects)
    .where(eq(projects.id, projectId));
  let value: ProjectRunnerPolicy | null = null;
  if (project) {
    const [settings] = await db
      .select({ dedicatedRunnerId: projectRunnerSettings.dedicatedRunnerId })
      .from(projectRunnerSettings)
      .where(eq(projectRunnerSettings.projectId, projectId));
    const grants = await db
      .select({ runnerId: projectRunnerGrants.runnerId })
      .from(projectRunnerGrants)
      .where(eq(projectRunnerGrants.projectId, projectId));
    value = {
      projectId,
      ownerId: project.userId,
      dedicatedRunnerId: settings?.dedicatedRunnerId ?? null,
      grantedRunnerIds: grants.map((g) => g.runnerId),
    };
  }
  policyCache.set(projectId, { value, at: Date.now() });
  return value;
}

/** May `runnerId` serve / read / write anything belonging to `projectId`? */
export async function canRunnerAccessProject(runnerId: string, projectId: string) {
  const [runner, policy] = await Promise.all([
    getRunnerScopeRecord(runnerId),
    getProjectRunnerPolicy(projectId),
  ]);
  if (!runner || !policy) return false;
  return evaluateRunnerAccess(runner, policy);
}

/** Projectless work (scratch threads, folder browsing, adding local projects). */
export async function canRunnerServeProjectless(runnerId: string) {
  const runner = await getRunnerScopeRecord(runnerId);
  return runner?.role === 'general';
}

/** Filter a list of project ids down to those `runnerId` may access. */
export async function filterAccessibleProjectIds(
  runnerId: string,
  projectIds: string[],
): Promise<Set<string>> {
  const allowed = new Set<string>();
  for (const id of new Set(projectIds)) {
    if (await canRunnerAccessProject(runnerId, id)) allowed.add(id);
  }
  return allowed;
}

/**
 * Runners that may serve `projectId` for its owner when the project is pinned
 * to a dedicated runner, in preference order. Returns `null` when the project
 * has no override (callers then use the general-runner resolution).
 */
export async function pinnedRunnerIdsForProject(
  projectId: string,
  userId: string,
): Promise<string[] | null> {
  const policy = await getProjectRunnerPolicy(projectId);
  if (!policy || !policy.dedicatedRunnerId || policy.ownerId !== userId) return null;
  return [policy.dedicatedRunnerId, ...policy.grantedRunnerIds];
}

/** The user's general runners, designated one first. */
export async function generalRunnerIdsForUser(userId: string): Promise<string[]> {
  const rows = await db
    .select({ id: runners.id })
    .from(runners)
    .where(and(eq(runners.userId, userId), eq(runners.role, 'general')));
  const designated = await getGeneralRunnerId(userId);
  const ids = rows.map((r) => r.id);
  if (designated && ids.includes(designated)) {
    return [designated, ...ids.filter((id) => id !== designated)];
  }
  return ids;
}

export async function getGeneralRunnerId(userId: string): Promise<string | null> {
  const [row] = await db
    .select({ generalRunnerId: userProfiles.generalRunnerId })
    .from(userProfiles)
    .where(eq(userProfiles.userId, userId));
  return row?.generalRunnerId ?? null;
}

export interface ProjectRunnerSettingsView {
  projectId: string;
  dedicatedRunnerId: string | null;
  grantedRunnerIds: string[];
  hasGithubToken: boolean;
}

export async function getProjectRunnerSettings(
  projectId: string,
): Promise<ProjectRunnerSettingsView | null> {
  const policy = await getProjectRunnerPolicy(projectId);
  if (!policy) return null;
  const [settings] = await db
    .select({ githubToken: projectRunnerSettings.githubToken })
    .from(projectRunnerSettings)
    .where(eq(projectRunnerSettings.projectId, projectId));
  return {
    projectId,
    dedicatedRunnerId: policy.dedicatedRunnerId,
    grantedRunnerIds: policy.grantedRunnerIds,
    hasGithubToken: !!settings?.githubToken,
  };
}

/** Encrypted project GitHub token, or null when the project inherits the user's. */
export async function getProjectGithubTokenCiphertext(projectId: string): Promise<string | null> {
  const [settings] = await db
    .select({ githubToken: projectRunnerSettings.githubToken })
    .from(projectRunnerSettings)
    .where(eq(projectRunnerSettings.projectId, projectId));
  return settings?.githubToken ?? null;
}

// ── Writes ─────────────────────────────────────────────────

export async function setRunnerRole(runnerId: string, role: RunnerRole): Promise<void> {
  await db.update(runners).set({ role }).where(eq(runners.id, runnerId));
  invalidateRunnerScope({ runnerId });
}

/** Designate (or clear) the user's general runner. Runner must belong to the user. */
export async function setGeneralRunner(userId: string, runnerId: string | null): Promise<boolean> {
  if (runnerId) {
    const runner = await getRunnerScopeRecord(runnerId);
    if (!runner || runner.userId !== userId) return false;
    if (runner.role !== 'general') await setRunnerRole(runnerId, 'general');
  }
  const now = new Date().toISOString();
  const updated = await db
    .update(userProfiles)
    .set({ generalRunnerId: runnerId, updatedAt: now })
    .where(eq(userProfiles.userId, userId))
    .returning({ id: userProfiles.id });
  if (updated.length === 0) {
    await db.insert(userProfiles).values({
      id: nanoid(),
      userId,
      generalRunnerId: runnerId,
      createdAt: now,
      updatedAt: now,
    });
  }
  invalidateRunnerScope();
  return true;
}

async function upsertSettings(
  projectId: string,
  patch: { dedicatedRunnerId?: string | null; githubToken?: string | null },
) {
  const now = new Date().toISOString();
  await db
    .insert(projectRunnerSettings)
    .values({
      projectId,
      dedicatedRunnerId: patch.dedicatedRunnerId ?? null,
      githubToken: patch.githubToken ?? null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: projectRunnerSettings.projectId,
      set: { ...patch, updatedAt: now },
    });
}

/**
 * Pin `projectId` to a dedicated runner of its owner (or clear the override).
 * Returns the runners that LOST access so callers can revoke their sessions.
 */
export async function setProjectDedicatedRunner(
  projectId: string,
  ownerId: string,
  runnerId: string | null,
): Promise<{ ok: boolean; revokedRunnerIds: string[] }> {
  const before = await getProjectRunnerPolicy(projectId);
  if (!before || before.ownerId !== ownerId) return { ok: false, revokedRunnerIds: [] };
  if (runnerId) {
    const runner = await getRunnerScopeRecord(runnerId);
    if (!runner || runner.userId !== ownerId) return { ok: false, revokedRunnerIds: [] };
  }
  const ownerRunners = await db
    .select({ id: runners.id, userId: runners.userId, role: runners.role })
    .from(runners)
    .where(eq(runners.userId, ownerId));
  const hadAccess = new Set(
    ownerRunners.filter((r) => evaluateRunnerAccess(toRecord(r), before)).map((r) => r.id),
  );

  await upsertSettings(projectId, { dedicatedRunnerId: runnerId });
  invalidateRunnerScope({ projectId });

  const after = await getProjectRunnerPolicy(projectId);
  const revokedRunnerIds = after
    ? ownerRunners
        .filter((r) => hadAccess.has(r.id) && !evaluateRunnerAccess(toRecord(r), after))
        .map((r) => r.id)
    : [];
  return { ok: true, revokedRunnerIds };
}

export async function grantProjectRunner(
  projectId: string,
  ownerId: string,
  runnerId: string,
): Promise<boolean> {
  const policy = await getProjectRunnerPolicy(projectId);
  const runner = await getRunnerScopeRecord(runnerId);
  if (!policy || policy.ownerId !== ownerId || !runner || runner.userId !== ownerId) return false;
  await db
    .insert(projectRunnerGrants)
    .values({
      projectId,
      runnerId,
      grantedBy: ownerId,
      createdAt: new Date().toISOString(),
    })
    .onConflictDoNothing();
  invalidateRunnerScope({ projectId });
  return true;
}

/** Remove a grant. Returns true when the runner no longer has access afterwards. */
export async function revokeProjectRunner(
  projectId: string,
  ownerId: string,
  runnerId: string,
): Promise<{ ok: boolean; lostAccess: boolean }> {
  const policy = await getProjectRunnerPolicy(projectId);
  if (!policy || policy.ownerId !== ownerId) return { ok: false, lostAccess: false };
  await db
    .delete(projectRunnerGrants)
    .where(
      and(eq(projectRunnerGrants.projectId, projectId), eq(projectRunnerGrants.runnerId, runnerId)),
    );
  invalidateRunnerScope({ projectId });
  return {
    ok: true,
    lostAccess: !(await canRunnerAccessProject(runnerId, projectId)),
  };
}

/** Store (encrypted) or clear the project's GitHub token override. */
export async function setProjectGithubTokenCiphertext(
  projectId: string,
  ciphertext: string | null,
): Promise<void> {
  await upsertSettings(projectId, { githubToken: ciphertext });
}

/**
 * The single project a dedicated runner is pinned to, if exactly one. Used when
 * a runner asks for project-scoped credentials without naming the project.
 */
export async function soleDedicatedProject(runnerId: string): Promise<string | null> {
  const runner = await getRunnerScopeRecord(runnerId);
  if (runner?.role !== 'dedicated') return null;
  const rows = await db
    .select({ projectId: projectRunnerSettings.projectId })
    .from(projectRunnerSettings)
    .where(eq(projectRunnerSettings.dedicatedRunnerId, runnerId));
  return rows.length === 1 ? rows[0].projectId : null;
}

/**
 * GitHub token for a git operation: the project's own token when it has one
 * (and `runnerId` may access the project), otherwise `null` so the caller
 * falls back to the user's personal token.
 */
export async function resolveProjectGithubToken(
  runnerId: string,
  projectId?: string | null,
): Promise<string | null> {
  const pid = projectId || (await soleDedicatedProject(runnerId));
  if (!pid || !(await canRunnerAccessProject(runnerId, pid))) return null;
  const ciphertext = await getProjectGithubTokenCiphertext(pid);
  return ciphertext ? decrypt(ciphertext) : null;
}

/** Set (plaintext, encrypted at rest) or clear the project's GitHub token. */
export async function setProjectGithubToken(projectId: string, token: string | null) {
  await setProjectGithubTokenCiphertext(projectId, token ? encrypt(token) : null);
}

function toRecord(r: { id: string; userId: string | null; role: string }): RunnerScopeRecord {
  return {
    id: r.id,
    userId: r.userId,
    role: r.role === 'dedicated' ? 'dedicated' : 'general',
  };
}
