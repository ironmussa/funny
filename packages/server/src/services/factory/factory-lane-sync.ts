/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: application-service
 * @domain layer: application
 *
 * Keeping a lane's branch close to the branch the factory merges into
 * (openspec factory-lanes, D4), so the lane's final pull request holds only
 * the feature. A sync is not a flow run: it has no issue, and a run's review
 * and risk gates would judge the whole base as its change. Its state lives on
 * the lane row and moves only along `LANE_SYNC_TRANSITIONS`, with a
 * compare-and-set, so two server instances start one sync and a restart
 * resumes from the row.
 *
 * One step per watcher tick:
 *
 * - `idle`: when the base has a head the lane does not contain, and the last
 *   sync started more than an hour ago, start one (`merging`).
 * - `merging`: put the scratch branch `factory/sync/<lane>` at the lane's head
 *   and merge the base's head into it on GitHub (a merge commit, on the scratch
 *   branch, never on the lane). Clean: open the pull request into the lane
 *   (`checking`). Conflict: `needs_human`.
 * - `checking`: when the pull request's checks are green, merge it with a merge
 *   commit (never squash: the lane must contain the base's commits, or every
 *   later sync conflicts again), holding the lane's merge group so it takes
 *   turns with the lane's runs. Back to `idle`.
 * - `needs_human`: a conflict, failing checks, or a refusal. It leaves by a
 *   member's retry, or by itself once the lane contains the base (a person
 *   merged it by hand).
 */
import type { CiState } from '@funny/core/github-app';

import { log } from '../../lib/logger.js';
import type { FactoryLaneBranches } from './factory-branch-reads.js';
import type { FactoryRepoReader } from './factory-github.js';
import type { FactoryLanesRepository, FactoryLaneView } from './factory-lanes.js';
import type { FactoryPullRequestRef, FactoryPullRequests } from './factory-pull-requests.js';

export type LaneSyncState = 'idle' | 'merging' | 'resolving' | 'checking' | 'needs_human';

/** Every move of a lane's sync state: the states it leaves and the one it enters. */
export const LANE_SYNC_TRANSITIONS = {
  /** The base moved: bring it in. */
  start: { from: ['idle'], to: 'merging' },
  /** The merge on the scratch branch was clean, and its pull request is open. */
  clean: { from: ['merging'], to: 'checking' },
  /** The scratch branch already had the base: nothing to bring in. */
  nothing: { from: ['merging'], to: 'idle' },
  /** The pull request merged into the lane. */
  merged: { from: ['checking'], to: 'idle' },
  /** A conflict, failing checks or a refusal: a person looks. */
  fail: { from: ['merging', 'resolving', 'checking'], to: 'needs_human' },
  /** A member asks to try again. */
  retry: { from: ['needs_human'], to: 'merging' },
  /** The lane contains the base after all (a person merged it by hand). */
  settle: { from: ['needs_human'], to: 'idle' },
} as const satisfies Record<string, { from: readonly LaneSyncState[]; to: LaneSyncState }>;

export type LaneSyncEvent = keyof typeof LANE_SYNC_TRANSITIONS;

/** The state `event` leads to from `from`, or null when it does not apply there. */
export function nextLaneSyncState(from: LaneSyncState, event: LaneSyncEvent): LaneSyncState | null {
  const move = LANE_SYNC_TRANSITIONS[event];
  return move.from.some((state) => state === from) ? move.to : null;
}

/** A new sync of a lane starts at most this often, unless a member asks. */
export const LANE_SYNC_MIN_INTERVAL_MS = 60 * 60 * 1000;

/** How long a sync's pull request may show no check at all before a person is told. */
export const LANE_SYNC_NO_CHECKS_MS = 15 * 60 * 1000;

/** How long the sync holds the lane's merge group for its one merge call. */
const MERGE_TURN_MS = 2 * 60 * 1000;

/** The factory's own scratch branch of a lane's sync. */
export const laneSyncBranch = (lane: Pick<FactoryLaneView, 'name'>): string =>
  `factory/sync/${lane.name}`;

/** The concurrency group the lane's runs merge under (`MERGE_LANE_GROUP` of `factory-flow.ts`). */
export const laneMergeGroup = (repo: string, branch: string): string => `merge:${repo}:${branch}`;

export interface LaneSyncDeps {
  lanes: Pick<FactoryLanesRepository, 'list' | 'moveSync'>;
  /** The branch operations, as the factory's enabler. */
  branches: FactoryLaneBranches;
  pullRequests: Pick<FactoryPullRequests, 'ciState' | 'pullHead' | 'merge'>;
  /** The branch the factory merges into (never a run's base: the reader carries none). */
  baseBranch: () => Promise<string | null>;
  /** The lane's merge group, taken for the one merge call. */
  mergeTurn: {
    holders(group: string): Promise<string[]>;
    take(group: string, holder: string, untilMs: number): Promise<void>;
    release(group: string, holder: string): Promise<void>;
  };
  now?: () => number;
}

export interface LaneSyncTarget {
  factoryId: string;
  reader: FactoryRepoReader;
}

export function createLaneSync(deps: LaneSyncDeps, target: LaneSyncTarget) {
  const now = deps.now ?? Date.now;
  const { repo } = target.reader;

  const move = (
    lane: FactoryLaneView,
    event: LaneSyncEvent,
    changes: Parameters<FactoryLanesRepository['moveSync']>[2] = {},
  ) =>
    deps.lanes.moveSync(lane.id, LANE_SYNC_TRANSITIONS[event], changes).then((moved) => {
      const won = moved.isOk() && moved.value;
      if (won) {
        log.info('Issue factory lane sync moved', {
          namespace: 'factory',
          factoryId: target.factoryId,
          lane: lane.name,
          event,
          to: LANE_SYNC_TRANSITIONS[event].to,
          error: changes.syncError ?? undefined,
        });
      }
      return won;
    });

  const failed = (lane: FactoryLaneView, why: string) => move(lane, 'fail', { syncError: why });

  const pullRequestOf = (lane: FactoryLaneView, number: number): FactoryPullRequestRef => ({
    repo,
    number,
    branch: laneSyncBranch(lane),
    userId: target.reader.ownerId,
    projectId: target.reader.projectId,
  });

  /** The head of the branch the factory merges into, with its name; null when unreadable now. */
  async function baseHead(): Promise<{ branch: string; sha: string } | null> {
    const base = await deps.baseBranch();
    if (!base) return null;
    const sha = await deps.branches.branchHead(base);
    return sha.isOk() && sha.value ? { branch: base, sha: sha.value } : null;
  }

  async function contains(branch: string, sha: string): Promise<boolean | null> {
    const read = await deps.branches.branchContains(branch, sha);
    return read.isOk() ? read.value : null;
  }

  async function whenIdle(lane: FactoryLaneView): Promise<void> {
    const base = await baseHead();
    if (!base || base.sha === lane.lastSyncedBaseSha) return;
    const has = await contains(lane.branch, base.sha);
    if (has === null) return;
    if (has) {
      // Nothing to bring in: remember the head so it is not asked again.
      await deps.lanes.moveSync(
        lane.id,
        { from: ['idle'], to: 'idle' },
        { lastSyncedBaseSha: base.sha },
      );
      return;
    }
    const last = lane.syncStartedAt ? Date.parse(lane.syncStartedAt) : null;
    if (last !== null && now() - last < LANE_SYNC_MIN_INTERVAL_MS) return;
    const started = await move(lane, 'start', {
      syncBaseSha: base.sha,
      syncStartedAt: new Date(now()).toISOString(),
      syncAttempts: 0,
      syncError: null,
      syncPrNumber: null,
      syncThreadId: null,
    });
    if (started) await whenMerging({ ...lane, syncBaseSha: base.sha }, base.branch);
  }

  async function whenMerging(lane: FactoryLaneView, baseName?: string): Promise<void> {
    const sha = lane.syncBaseSha;
    if (!sha) {
      await failed(lane, 'The sync lost the commit it was bringing in. Retry it.');
      return;
    }
    const head = await deps.branches.branchHead(lane.branch);
    if (head.isErr()) return;
    if (!head.value) {
      await failed(lane, `The branch ${lane.branch} does not exist on GitHub any more.`);
      return;
    }
    const scratch = laneSyncBranch(lane);
    const reset = await deps.branches.resetBranch(scratch, head.value);
    if (reset.isErr()) {
      await failed(lane, `The branch ${scratch} could not be prepared: ${reset.error.message}`);
      return;
    }
    const from = baseName ?? 'the base branch';
    const merged = await deps.branches.mergeInto(scratch, sha, `Merge ${from} into ${lane.branch}`);
    if (merged.isErr()) {
      await failed(
        lane,
        `GitHub could not merge ${from} into ${lane.branch}: ${merged.error.message}`,
      );
      return;
    }
    if (merged.value === 'conflict') {
      await failed(
        lane,
        `Merging ${from} into ${lane.branch} conflicts. Merge it by hand and push ${lane.branch}; the lane goes on by itself afterwards.`,
      );
      return;
    }
    if (merged.value === 'nothing') {
      await move(lane, 'nothing', { lastSyncedBaseSha: sha, syncBaseSha: null });
      return;
    }
    const opened = await deps.branches.openPullRequest({
      head: scratch,
      base: lane.branch,
      title: `Sync ${lane.branch} with ${from}`,
      body: [
        `The issue factory brings \`${from}\` into the lane \`${lane.branch}\` so the lane stays close to it.`,
        '',
        'It is merged with a merge commit once its checks pass. Do not squash it: the lane must contain the commits it brings in.',
      ].join('\n'),
    });
    if (opened.isErr()) {
      await failed(lane, `The sync pull request could not be opened: ${opened.error.message}`);
      return;
    }
    await move(lane, 'clean', { syncPrNumber: opened.value });
  }

  /** Why checks that are not green stop the sync, or null while it should keep waiting. */
  function checksProblem(lane: FactoryLaneView, ci: CiState): string | null {
    if (ci.kind === 'failing' || ci.kind === 'blocked') {
      const names = ci.checks.map((check) => check.name).join(', ');
      return `The checks of the sync pull request #${lane.syncPrNumber} fail (${names}).`;
    }
    if (ci.kind !== 'none') return null;
    const started = lane.syncStartedAt ? Date.parse(lane.syncStartedAt) : now();
    return now() - started > LANE_SYNC_NO_CHECKS_MS
      ? `No check ran for the sync pull request #${lane.syncPrNumber}: the repository's workflows may not run for pull requests into ${lane.branch}.`
      : null;
  }

  async function whenChecking(lane: FactoryLaneView): Promise<void> {
    if (lane.syncPrNumber === null) {
      await failed(lane, 'The sync has no pull request. Retry it.');
      return;
    }
    const pr = pullRequestOf(lane, lane.syncPrNumber);
    const ci = await deps.pullRequests.ciState(pr);
    if (ci.isErr()) return;
    if (ci.value.kind !== 'green') {
      const problem = checksProblem(lane, ci.value);
      if (problem) await failed(lane, problem);
      return;
    }
    const head = await deps.pullRequests.pullHead(pr);
    if (head.isErr()) return;

    // One merge into the lane at a time: the lane's runs merge under this group.
    const group = laneMergeGroup(repo, lane.branch);
    const holder = `lane-sync:${lane.id}`;
    if ((await deps.mergeTurn.holders(group)).some((other) => other !== holder)) return;
    await deps.mergeTurn.take(group, holder, now() + MERGE_TURN_MS);
    try {
      // A run was granted the group at the same moment: it goes first.
      if ((await deps.mergeTurn.holders(group)).some((other) => other !== holder)) return;
      const outcome = await deps.pullRequests.merge(pr, {
        sha: head.value.sha,
        method: 'merge',
        deleteBranch: true,
      });
      if (outcome.isErr()) return;
      if (outcome.value.kind === 'merged') {
        await move(lane, 'merged', {
          lastSyncedBaseSha: lane.syncBaseSha,
          syncBaseSha: null,
          syncPrNumber: null,
          syncError: null,
        });
        await deps.branches.deleteBranch(laneSyncBranch(lane));
      } else if (outcome.value.kind === 'not-mergeable') {
        await failed(
          lane,
          `GitHub refused to merge the sync pull request #${pr.number} with a merge commit: ${outcome.value.reason}. The repository must allow merge commits.`,
        );
      }
    } finally {
      await deps.mergeTurn.release(group, holder);
    }
  }

  async function whenNeedsHuman(lane: FactoryLaneView): Promise<void> {
    const base = await baseHead();
    if (!base) return;
    if (await contains(lane.branch, base.sha)) {
      await move(lane, 'settle', {
        lastSyncedBaseSha: base.sha,
        syncBaseSha: null,
        syncPrNumber: null,
        syncError: null,
      });
    }
  }

  async function step(lane: FactoryLaneView): Promise<void> {
    switch (lane.syncState) {
      case 'idle':
        return whenIdle(lane);
      case 'merging':
        return whenMerging(lane);
      case 'checking':
        return whenChecking(lane);
      case 'needs_human':
        return whenNeedsHuman(lane);
      default:
        return undefined;
    }
  }

  return {
    /** Advance the sync of each active lane of the factory by one step. */
    async tick(): Promise<void> {
      const lanes = await deps.lanes.list(target.factoryId);
      if (lanes.isErr()) return;
      for (const lane of lanes.value) {
        if (lane.state !== 'active') continue;
        await step(lane).catch((cause: unknown) => {
          log.warn('Issue factory lane sync step failed', {
            namespace: 'factory',
            factoryId: target.factoryId,
            lane: lane.name,
            error: cause instanceof Error ? cause.message : String(cause),
          });
        });
      }
    },
  };
}
