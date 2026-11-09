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
 *   - A `sandbox` runner (change thread-sandboxes) is bound to exactly one thread
 *     and serves nothing else: no project-level work, no projectless work, and
 *     no other thread — not even through an explicit grant. Requests for that
 *     thread go ONLY to it (`sandboxRunnerIdForThread`).
 *   - `runner_project_assignments` stays a LOCATION record (where the project
 *     lives on a runner's disk). Runners write it themselves, so it is never an
 *     authorization source.
 *
 * Every routing / data-channel / push decision about runner↔project access MUST
 * go through `canRunnerAccessProject` / `canRunnerServeProjectless` — never
 * re-derive the rule at a call site.
 */

import { and, eq, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';

import { db } from '../db/index.js';
import {
  projectRunnerGrants,
  projectRunnerSettings,
  projects,
  runnerPolicyVersion,
  runners,
  userProfiles,
} from '../db/schema.js';
import { decrypt, encrypt } from '../lib/crypto.js';
import { log } from '../lib/logger.js';

export type RunnerRole = 'general' | 'dedicated' | 'sandbox';

export interface RunnerScopeRecord {
  id: string;
  userId: string | null;
  role: RunnerRole;
  /** Bound thread for a `sandbox` runner, otherwise null. */
  threadId?: string | null;
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
  if (runner.role === 'sandbox') return false;
  if (policy.dedicatedRunnerId === runner.id) return true;
  if (policy.grantedRunnerIds.includes(runner.id)) return true;
  if (runner.role === 'dedicated') return false;
  // A general runner serves the project unless the project's owner pinned it
  // to a dedicated runner. A collaborator's own general runner is unaffected
  // by the owner's override (it works from the collaborator's checkout).
  return !(policy.dedicatedRunnerId && runner.userId === policy.ownerId);
}

// ── Cache ──────────────────────────────────────────────────
//
// Routing-policy caches are only valid at the policy version they were read
// at. Every scope change bumps `runner_policy_version` in the DB; every read
// first syncs that version (one primary-key lookup) and ignores entries from
// an older one. So a revocation made on any server instance applies to every
// instance on its next read — not after the TTL. The TTL stays as a backstop.

const CACHE_TTL_MS = 30_000;

interface CacheEntry<T> {
  value: T;
  at: number;
  /** Policy version at which `value` was read. */
  version: number;
}

const runnerCache = new Map<string, CacheEntry<RunnerScopeRecord | null>>();
const policyCache = new Map<string, CacheEntry<ProjectRunnerPolicy | null>>();
const sandboxByThreadCache = new Map<string, CacheEntry<string | null>>();

/** Highest policy version this instance has seen; -1 = not read yet. */
let knownVersion = -1;

function fresh<T>(entry: CacheEntry<T> | undefined): entry is CacheEntry<T> {
  return !!entry && entry.version === knownVersion && Date.now() - entry.at < CACHE_TTL_MS;
}

type ScopeChangeListener = (change: { runnerId?: string; projectId?: string }) => void;
const listeners = new Set<ScopeChangeListener>();

/** Subscribe to scope changes (e.g. to evict routing caches). Returns unsubscribe. */
export function onRunnerScopeChange(listener: ScopeChangeListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function clearLocal(change: { runnerId?: string; projectId?: string }) {
  if (change.runnerId) runnerCache.delete(change.runnerId);
  if (change.projectId) policyCache.delete(change.projectId);
  if (!change.runnerId && !change.projectId) {
    runnerCache.clear();
    policyCache.clear();
    sandboxByThreadCache.clear();
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

/**
 * Read the DB policy version and drop every cache entry from an older one.
 * Returns the version to tag entries read after this call with. If the
 * version cannot be read, returns a fresh sentinel so nothing is served from
 * (or kept in) the cache — fail closed to the DB, never to a stale answer.
 */
export async function syncRunnerPolicyVersion(): Promise<number> {
  let version: number;
  try {
    const [row] = await db
      .select({ version: runnerPolicyVersion.version })
      .from(runnerPolicyVersion)
      .where(eq(runnerPolicyVersion.id, 1));
    // A missing row (migration 092 seeds it) cannot prove the cache is
    // current either: bumps would update nothing.
    if (!row) throw new Error('runner_policy_version row is missing');
    version = Number(row.version);
  } catch (error) {
    log.warn('Runner policy version unavailable — routing caches bypassed', {
      namespace: 'runner-scope',
      error: (error as Error).message,
    });
    clearLocal({});
    knownVersion = -1;
    return -2;
  }
  if (version > knownVersion) {
    if (knownVersion !== -1) clearLocal({});
    knownVersion = version;
  }
  return version;
}

/** The policy version the caches currently trust (for caches outside this module). */
export function currentRunnerPolicyVersion(): number {
  return knownVersion;
}

/**
 * Record a scope change: drop this instance's cached entries now, and bump the
 * DB version so every other instance drops theirs on its next read. Awaited by
 * the request that made the change, after the change is written.
 */
async function invalidateRunnerScope(change: { runnerId?: string; projectId?: string } = {}) {
  clearLocal(change);
  try {
    const [row] = await db
      .update(runnerPolicyVersion)
      .set({ version: sql`${runnerPolicyVersion.version} + 1` })
      .where(eq(runnerPolicyVersion.id, 1))
      .returning({ version: runnerPolicyVersion.version });
    if (!row) throw new Error('runner_policy_version row is missing');
    knownVersion = Math.max(knownVersion, Number(row.version));
  } catch (error) {
    // Other instances keep their caches until the TTL: make that loud.
    log.error('Runner policy version bump failed — other instances may serve stale routing', {
      namespace: 'runner-scope',
      error: (error as Error).message,
    });
  }
}

/** Record that runners were deleted (their cached scope must not be served). */
export async function runnersDeleted(runnerIds: string[]): Promise<void> {
  if (runnerIds.length === 0) return;
  for (const runnerId of runnerIds) clearLocal({ runnerId });
  sandboxByThreadCache.clear();
  await invalidateRunnerScope({});
}

/** Test helper. */
export function __resetRunnerScopeCache() {
  runnerCache.clear();
  policyCache.clear();
  sandboxByThreadCache.clear();
  knownVersion = -1;
}

// ── Reads ──────────────────────────────────────────────────

function parseRunnerRole(role: string): RunnerRole {
  return role === 'dedicated' || role === 'sandbox' ? role : 'general';
}

async function getRunnerScopeRecord(runnerId: string): Promise<RunnerScopeRecord | null> {
  const version = await syncRunnerPolicyVersion();
  const cached = runnerCache.get(runnerId);
  if (fresh(cached)) return cached.value;
  const [row] = await db
    .select({
      id: runners.id,
      userId: runners.userId,
      role: runners.role,
      threadId: runners.threadId,
    })
    .from(runners)
    .where(eq(runners.id, runnerId));
  const value: RunnerScopeRecord | null = row
    ? {
        id: row.id,
        userId: row.userId,
        role: parseRunnerRole(row.role),
        threadId: row.role === 'sandbox' ? row.threadId : null,
      }
    : null;
  runnerCache.set(runnerId, { value, at: Date.now(), version });
  return value;
}

async function getProjectRunnerPolicy(projectId: string): Promise<ProjectRunnerPolicy | null> {
  const version = await syncRunnerPolicyVersion();
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
  policyCache.set(projectId, { value, at: Date.now(), version });
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

/** The thread a `sandbox` runner is bound to, or null for any other runner. */
export async function sandboxThreadOfRunner(runnerId: string): Promise<string | null> {
  const runner = await getRunnerScopeRecord(runnerId);
  return runner?.role === 'sandbox' ? (runner.threadId ?? null) : null;
}

/**
 * The sandbox runner bound to `threadId`, or null when the thread has none.
 * When set, it is the ONLY runner that may serve the thread.
 */
export async function sandboxRunnerIdForThread(threadId: string): Promise<string | null> {
  const version = await syncRunnerPolicyVersion();
  const cached = sandboxByThreadCache.get(threadId);
  if (fresh(cached)) return cached.value;
  const [row] = await db
    .select({ id: runners.id })
    .from(runners)
    .where(and(eq(runners.threadId, threadId), eq(runners.role, 'sandbox')));
  const value = row?.id ?? null;
  sandboxByThreadCache.set(threadId, { value, at: Date.now(), version });
  return value;
}

/** Projectless work (scratch threads, folder browsing, adding local projects). */
export async function canRunnerServeProjectless(runnerId: string) {
  const runner = await getRunnerScopeRecord(runnerId);
  return runner?.role === 'general';
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
async function getProjectGithubTokenCiphertext(projectId: string): Promise<string | null> {
  const [settings] = await db
    .select({ githubToken: projectRunnerSettings.githubToken })
    .from(projectRunnerSettings)
    .where(eq(projectRunnerSettings.projectId, projectId));
  return settings?.githubToken ?? null;
}

// ── Writes ─────────────────────────────────────────────────

export async function setRunnerRole(runnerId: string, role: RunnerRole): Promise<void> {
  await db.update(runners).set({ role }).where(eq(runners.id, runnerId));
  await invalidateRunnerScope({ runnerId });
}

/** Make `runnerId` the sandbox runner of `threadId` (it then serves nothing else). */
export async function bindSandboxRunner(runnerId: string, threadId: string): Promise<void> {
  await db.update(runners).set({ role: 'sandbox', threadId }).where(eq(runners.id, runnerId));
  sandboxByThreadCache.delete(threadId);
  await invalidateRunnerScope({ runnerId });
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
  await invalidateRunnerScope();
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
  await invalidateRunnerScope({ projectId });

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
  await invalidateRunnerScope({ projectId });
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
  await invalidateRunnerScope({ projectId });
  return {
    ok: true,
    lostAccess: !(await canRunnerAccessProject(runnerId, projectId)),
  };
}

/** Store (encrypted) or clear the project's GitHub token override. */
async function setProjectGithubTokenCiphertext(
  projectId: string,
  ciphertext: string | null,
): Promise<void> {
  await upsertSettings(projectId, { githubToken: ciphertext });
}

/**
 * The single project a dedicated runner is pinned to, if exactly one. Used when
 * a runner asks for project-scoped credentials without naming the project.
 */
async function soleDedicatedProject(runnerId: string): Promise<string | null> {
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
