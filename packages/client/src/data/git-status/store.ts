import type { GitStatusInfo } from '@funny/shared';

import type { DataLayer } from '../data-layer';
import { createEntityStore, type EntityStore } from '../entities';
import { getDataLayer } from '../runtime';
import { statusEqual, type ProjectGitStatus } from './keys';

/**
 * Git status as three collections:
 * - statuses keyed by branch key (threads sharing a working state share one);
 * - the server's thread → branch key mapping;
 * - project-root status keyed by project id.
 * They are fed by status requests (`actions.ts`) and `git:status` events.
 *
 * Several paths write the same branch row (a thread fetch, a project bulk
 * fetch, events), so every write carries a dispatch token and a row is only
 * overwritten by a newer token: a slow bulk fetch sent before a pull cannot
 * land after a forced post-pull fetch and pin a stale "behind" badge.
 */

export type StatusRow = GitStatusInfo & { id: string };
export type ThreadKeyRow = { id: string; branchKey: string };
export type ProjectStatusRow = ProjectGitStatus & { id: string };

export interface GitStatusData {
  readonly statuses: EntityStore<StatusRow>;
  readonly threadKeys: EntityStore<ThreadKeyRow>;
  readonly projects: EntityStore<ProjectStatusRow>;
  /** Newest token that wrote each branch row / project row. */
  readonly appliedSeqByBranch: Map<string, number>;
  readonly appliedSeqByProject: Map<string, number>;
  seq: number;
  /** Scope key ('' = whole project) of the last bulk fetch per project. */
  readonly fetchedScopeByProject: Map<string, string>;
}

export function getGitStatusData(layer: DataLayer = getDataLayer()): GitStatusData {
  return layer.own('git-status', () => {
    const data: GitStatusData = {
      statuses: createEntityStore<StatusRow>(layer, 'git-status'),
      threadKeys: createEntityStore<ThreadKeyRow>(layer, 'git-status-thread-keys'),
      projects: createEntityStore<ProjectStatusRow>(layer, 'git-status-projects'),
      appliedSeqByBranch: new Map(),
      appliedSeqByProject: new Map(),
      seq: 0,
      fetchedScopeByProject: new Map(),
    };
    return {
      value: data,
      dispose: () => {
        for (const store of [data.statuses, data.threadKeys, data.projects]) {
          void store.collection.cleanup({ dependents: true }).catch(() => undefined);
        }
      },
    };
  });
}

/** Reserve the write token of a freshly dispatched request (or an event). */
export function nextStatusSeq(data: GitStatusData): number {
  return ++data.seq;
}

/** Claim a write for `seq`; false when a newer write already landed. */
function claim(map: Map<string, number>, key: string, seq: number): boolean {
  if (seq < (map.get(key) ?? 0)) return false;
  map.set(key, seq);
  return true;
}

/**
 * Write branch statuses dispatched at `seq` and their thread mappings. Stale
 * statuses are dropped (the mapping is stable and always kept); unchanged
 * ones keep their row reference so views do not re-render.
 */
export function writeStatuses(
  data: GitStatusData,
  statuses: readonly GitStatusInfo[],
  seq: number,
): void {
  const rows: StatusRow[] = [];
  const keys: ThreadKeyRow[] = [];
  for (const status of statuses) {
    const bk = status.branchKey;
    if (data.threadKeys.getSynced(status.threadId)?.branchKey !== bk) {
      keys.push({ id: status.threadId, branchKey: bk });
    }
    if (!claim(data.appliedSeqByBranch, bk, seq)) continue;
    const prev = data.statuses.getSynced(bk);
    if (!prev || !statusEqual(prev, status)) rows.push({ ...status, id: bk });
  }
  if (rows.length) data.statuses.upsert(rows);
  if (keys.length) data.threadKeys.upsert(keys);
}

export function writeProjectStatus(
  data: GitStatusData,
  projectId: string,
  status: ProjectGitStatus,
  seq: number,
): void {
  if (!claim(data.appliedSeqByProject, projectId, seq)) return;
  data.projects.upsert([{ ...status, id: projectId }]);
}

/** Patch a branch row as a fresh write (e.g. PR metadata found by the PR tab). */
export function patchStatus(data: GitStatusData, bk: string, patch: Partial<GitStatusInfo>): void {
  const prev = data.statuses.getSynced(bk);
  if (!prev) return;
  const next = { ...prev, ...patch };
  if (statusEqual(prev, next)) return;
  if (!claim(data.appliedSeqByBranch, bk, nextStatusSeq(data))) return;
  data.statuses.upsert([next]);
}

// ── Thread scope ─────────────────────────────────────────────
// A project can hold thousands of threads while the sidebar shows a handful.
// Views register which threads they render; the bulk fetch asks the runner for
// just that union. A view that needs every thread (All threads, Kanban, archived
// settings) registers 'all'. No registration for a project = whole project.
export type GitStatusScope = Record<string, string[] | 'all'>;
const scopeByConsumer = new Map<string, GitStatusScope>();

/** Register (or replace) the threads a mounted view needs status for. */
export function setGitStatusScope(consumerId: string, scope: GitStatusScope): void {
  scopeByConsumer.set(consumerId, scope);
}

export function clearGitStatusScope(consumerId: string): void {
  scopeByConsumer.delete(consumerId);
}

/** Sorted thread IDs to fetch for `projectId`, or null for the whole project. */
export function resolveThreadScope(projectId: string): string[] | null {
  const ids = new Set<string>();
  let registered = false;
  for (const scope of scopeByConsumer.values()) {
    const entry = scope[projectId];
    if (!entry) continue;
    if (entry === 'all') return null;
    registered = true;
    for (const id of entry) ids.add(id);
  }
  return registered && ids.size > 0 ? [...ids].sort() : null;
}

/** True when `next` asks for threads the previous fetch (`prev`) did not cover. */
export function scopeWidened(prev: string | undefined, next: string): boolean {
  if (prev === undefined) return true;
  if (prev === '') return false; // previous fetch covered the whole project
  if (next === '') return true;
  const covered = new Set(prev.split(','));
  return next.split(',').some((id) => !covered.has(id));
}

/** @internal Forget registered scopes (tests). */
export function resetGitStatusScopes(): void {
  scopeByConsumer.clear();
}
