import type { GitStatusInfo } from '@funny/shared';

import { gitApi } from '@/lib/api/git';
import { isScratch, runsInSandbox, sandboxSetupFailed } from '@/lib/thread-variant';

import type { DataLayer } from '../data-layer';
import { unwrapResult } from '../query-client';
import { getDataLayer } from '../runtime';
import { readThreadRow } from '../threads/read';
import { branchKey } from './keys';
import {
  getGitStatusData,
  nextStatusSeq,
  patchStatus,
  resolveThreadScope,
  scopeWidened,
  writeProjectStatus,
  writeStatuses,
} from './store';

/**
 * Git status requests. Each request kind is a query: concurrent callers share
 * the in-flight request, a fresh result (younger than `STATUS_FRESH_MS`) is
 * reused, and `force` cancels an in-flight request (aborting it through the
 * query signal) before asking again. Status is best-effort: failures are
 * swallowed (and reused like a result) and the previous rows stay.
 */

const STATUS_FRESH_MS = 5_000;

type Thread = {
  id: string;
  projectId: string;
  mode?: string | null;
  branch?: string | null;
  worktreePath?: string | null;
  baseBranch?: string | null;
  runtime?: string | null;
};

const projectKey = (projectId: string) => ['git-status', 'project', projectId] as const;
const threadKey = (key: string) => ['git-status', 'thread', key] as const;
const rootKey = (projectId: string) => ['git-status', 'root', projectId] as const;

/**
 * `queryFn` gets the write token reserved when the call was made: the query
 * function itself starts a microtask later, after events that arrived in
 * between, which must still win over this (older) response.
 */
async function request(
  layer: DataLayer,
  queryKey: readonly unknown[],
  force: boolean,
  queryFn: (signal: AbortSignal, seq: number) => Promise<unknown>,
): Promise<void> {
  const seq = nextStatusSeq(getGitStatusData(layer));
  const { queryClient } = layer;
  if (force) await queryClient.cancelQueries({ queryKey, exact: true });
  await queryClient
    .fetchQuery({
      queryKey,
      staleTime: force ? 0 : STATUS_FRESH_MS,
      // A failure resolves too, so it is reused for the freshness period like
      // a success: a repeatedly failing status does not re-request on every call.
      queryFn: ({ signal }) =>
        queryFn(signal, seq).then(
          () => true,
          () => false,
        ),
    })
    .catch(() => undefined);
}

/** The branch key of a thread: the server's mapping, else computed from its row. */
function resolveBranchKey(threadId: string, layer: DataLayer): string | undefined {
  const mapped = getGitStatusData(layer).threadKeys.getSynced(threadId)?.branchKey;
  if (mapped) return mapped;
  const thread = readThreadRow(threadId, layer);
  return thread ? branchKey(thread) : undefined;
}

/**
 * Bulk status for a project's threads (the sidebar badges). Asks only for the
 * threads mounted views registered; a widened scope bypasses the freshness
 * period, since the last request did not cover the newly visible threads.
 */
export function fetchForProject(
  projectId: string,
  force = false,
  layer: DataLayer = getDataLayer(),
): Promise<void> {
  const data = getGitStatusData(layer);
  const threadIds = resolveThreadScope(projectId);
  const scope = threadIds ? threadIds.join(',') : '';
  const widened = scopeWidened(data.fetchedScopeByProject.get(projectId), scope);
  return request(layer, projectKey(projectId), force || widened, async (signal, seq) => {
    data.fetchedScopeByProject.set(projectId, scope);
    const result = threadIds
      ? await unwrapResult(gitApi.getGitStatuses(projectId, signal, threadIds))
      : await unwrapResult(gitApi.getGitStatuses(projectId, signal));
    writeStatuses(data, result.statuses, seq);
  });
}

/** Status of one thread; threads sharing a branch share the request and its freshness. */
export function fetchForThread(
  threadId: string,
  force = false,
  layer: DataLayer = getDataLayer(),
): Promise<void> {
  // Scratch threads have no git working tree (the runner rejects with 400),
  // and a sandbox whose setup failed has no runner to answer.
  const thread = readThreadRow(threadId, layer);
  if (isScratch(thread) || sandboxSetupFailed(thread)) return Promise.resolve();
  const data = getGitStatusData(layer);
  const key = resolveBranchKey(threadId, layer) ?? `pending:${threadId}`;
  return request(layer, threadKey(key), force, async (signal, seq) => {
    const status = await unwrapResult(gitApi.getGitStatus(threadId, signal));
    writeStatuses(data, [status], seq);
    // Requested before the branch key was known: the answer is fresh for the
    // real key too, so a sibling on the same branch reuses it.
    if (status.branchKey !== key) layer.queryClient.setQueryData(threadKey(status.branchKey), true);
  });
}

/**
 * Re-ask the status a review view shows, ignoring freshness (after a pull,
 * fetch, push or commit): the thread's, else the project root's.
 */
export function refreshGitStatus(
  threadId: string | null | undefined,
  projectModeId: string | null | undefined,
  layer: DataLayer = getDataLayer(),
): Promise<void> {
  if (threadId) return fetchForThread(threadId, true, layer);
  if (projectModeId) return fetchProjectStatus(projectModeId, true, layer);
  return Promise.resolve();
}

/** Status of a project root (project-mode review pane). */
export function fetchProjectStatus(
  projectId: string,
  force = false,
  layer: DataLayer = getDataLayer(),
): Promise<void> {
  const data = getGitStatusData(layer);
  return request(layer, rootKey(projectId), force, async (signal, seq) => {
    const status = await unwrapResult(gitApi.projectGitStatus(projectId, signal));
    writeProjectStatus(data, projectId, status, seq);
  });
}

/**
 * Make sure the listed threads have status, with ONE bulk request per project
 * that still has an uncovered branch: per-thread requests for worktree threads
 * (each with its own branch key) saturate the runner's data channel.
 */
export function ensureStatusForThreads(
  threads: readonly Thread[],
  layer: DataLayer = getDataLayer(),
): void {
  const { statuses } = getGitStatusData(layer);
  const projects = new Set<string>();
  for (const thread of threads) {
    if (isScratch(thread as { isScratch?: boolean }) || !thread.projectId) continue;
    // A project's bulk status never covers a sandbox thread (its checkout is
    // on its own runner); asking per thread would wake a stopped sandbox.
    if (runsInSandbox(thread)) continue;
    if (!statuses.getSynced(branchKey(thread))) projects.add(thread.projectId);
  }
  for (const projectId of projects) void fetchForProject(projectId, false, layer);
}

/**
 * `git:status` event: freshly computed server state. It takes the newest
 * token (wins over older in-flight requests) and makes the matching request
 * caches stale, so the next fetch asks again instead of reusing them.
 */
export function applyGitStatusEvent(
  statuses: readonly GitStatusInfo[],
  layer: DataLayer = getDataLayer(),
): void {
  const data = getGitStatusData(layer);
  writeStatuses(data, statuses, nextStatusSeq(data));
  markGitStatusStale(
    statuses.map((s) => s.branchKey),
    layer,
  );
}

/** Make the request caches behind these branch keys (and their projects) stale. */
export function markGitStatusStale(
  branchKeys: readonly string[],
  layer: DataLayer = getDataLayer(),
): void {
  const { queryClient } = layer;
  for (const bk of branchKeys) {
    void queryClient.invalidateQueries({ queryKey: threadKey(bk), refetchType: 'none' });
    // Branch keys are "projectId", "projectId:branch" or "wt:projectId:…".
    const projectId = bk.startsWith('wt:') ? bk.split(':')[1] : bk.split(':')[0];
    if (!projectId) continue;
    void queryClient.invalidateQueries({ queryKey: projectKey(projectId), refetchType: 'none' });
    void queryClient.invalidateQueries({ queryKey: rootKey(projectId), refetchType: 'none' });
  }
}

/** PR metadata discovered by the PR tab, written as a fresh status write. */
export function applyPRMetadata(
  threadId: string,
  pr: { prNumber: number; prUrl: string; prState: NonNullable<GitStatusInfo['prState']> },
  layer: DataLayer = getDataLayer(),
): void {
  const bk = resolveBranchKey(threadId, layer);
  if (!bk) return;
  patchStatus(getGitStatusData(layer), bk, {
    prNumber: pr.prNumber,
    prUrl: pr.prUrl,
    prState: pr.prState,
  });
}
