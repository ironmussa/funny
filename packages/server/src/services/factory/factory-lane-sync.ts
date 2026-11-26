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
 *   (`checking`). Conflict: the agent (`resolving`).
 * - `resolving`: one thread on the enabler's runtime, on the scratch branch,
 *   merges the base and settles what the server could not. When its turn
 *   ends with the scratch branch containing the base, back to `checking`;
 *   otherwise it is asked again, three turns in all.
 * - `checking`: failing checks go to the agent too. When the pull request's
 *   checks are green, merge it with a merge commit (never squash: the lane must
 *   contain the base's commits, or every later sync conflicts again), holding
 *   the lane's merge group so it takes turns with the lane's runs. Back to
 *   `idle`. An agent-settled sync merges without the factory's reviewer: what
 *   it wrote is in the lane's final pull request, which a person reviews.
 * - `needs_human`: no agent, its attempts used up, checks that cannot run, or a
 *   refusal. It leaves by a
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
  /** The merge conflicts: an agent settles it on the scratch branch. */
  conflict: { from: ['merging'], to: 'resolving' },
  /** The pull request's checks fail: the agent looks at them. */
  red: { from: ['checking'], to: 'resolving' },
  /** The agent's turn ended without the work done: it is asked again. */
  again: { from: ['resolving'], to: 'resolving' },
  /** The agent pushed a merge of the base: back to the checks. */
  resolved: { from: ['resolving'], to: 'checking' },
  /** A refusal, or the agent's attempts used up: a person looks. */
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

/** How many turns the agent gets on one sync before a person is asked. */
export const LANE_SYNC_MAX_ATTEMPTS = 3;

/** How long one sync may stay with its agent before a person is asked. */
export const LANE_SYNC_AGENT_LIMIT_MS = 3 * 60 * 60 * 1000;

const ENDED_THREAD: ReadonlySet<string> = new Set([
  'completed',
  'failed',
  'stopped',
  'interrupted',
]);

/** How long the sync holds the lane's merge group for its one merge call. */
const MERGE_TURN_MS = 2 * 60 * 1000;

/** What every message to the sync agent ends with. */
const RULES = [
  'Rules:',
  '- Keep it a merge: a merge commit of the base, never a rebase, a squash or a force push.',
  "- Run the project's checks before you push, and fix what the merge broke.",
  '- Push this branch to origin when you are done. Do not open a pull request, and do not push to any other branch.',
].join('\n');

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
  /**
   * The agent that settles a sync the server cannot: a thread on the enabler's
   * runtime, on the scratch branch. Absent: a conflict or failing checks wait
   * for a person.
   */
  agent?: {
    start(input: {
      title: string;
      prompt: string;
      /** The scratch branch the thread works on and pushes. */
      branch: string;
      /** The lane's branch, which the scratch branch was cut from. */
      baseBranch: string;
    }): Promise<{ threadId: string } | { error: string }>;
    /** Send the thread another message; whether it was taken. */
    followUp(threadId: string, content: string, branch: string): Promise<boolean>;
    /** The thread's status and when its last turn ended, or null when it is gone. */
    turn(threadId: string): Promise<{ status: string; completedAt: string | null } | null>;
  };
  now?: () => number;
}

export interface LaneSyncTarget {
  factoryId: string;
  reader: FactoryRepoReader;
}

/** What the agent part of a sync needs from the sync it belongs to. */
interface LaneSyncAgentContext {
  deps: LaneSyncDeps;
  now: () => number;
  move(
    lane: FactoryLaneView,
    event: LaneSyncEvent,
    changes?: Parameters<FactoryLanesRepository['moveSync']>[2],
  ): Promise<boolean>;
  failed(lane: FactoryLaneView, why: string): Promise<boolean>;
  contains(branch: string, sha: string): Promise<boolean | null>;
}

/**
 * The part of a lane sync its agent takes: handing it a conflict or failing
 * checks, judging its turn, and opening the sync's pull request.
 */
function createLaneSyncAgent({ deps, now, move, failed, contains }: LaneSyncAgentContext) {
  /** The sync's pull request into the lane (the open one, if it has one already); null: it failed. */
  async function openSyncPullRequest(lane: FactoryLaneView, from: string): Promise<number | null> {
    const opened = await deps.branches.openPullRequest({
      head: laneSyncBranch(lane),
      base: lane.branch,
      title: `Sync ${lane.branch} with ${from}`,
      body: [
        `The issue factory brings \`${from}\` into the lane \`${lane.branch}\` so the lane stays close to it.`,
        '',
        'It is merged with a merge commit once its checks pass. Do not squash it: the lane must contain the commits it brings in.',
      ].join('\n'),
    });
    if (opened.isOk()) return opened.value;
    await failed(lane, `The sync pull request could not be opened: ${opened.error.message}`);
    return null;
  }

  /**
   * Hand the sync to its agent: a new thread on the scratch branch the first
   * time, a follow-up on the same thread afterwards. With no agent, or its
   * attempts used up, a person is asked instead, with `problem` as the reason.
   */
  async function askAgent(
    lane: FactoryLaneView,
    event: 'conflict' | 'red' | 'again',
    what: { from: string; problem: string; ask: string },
  ): Promise<void> {
    const agent = deps.agent;
    if (!agent) {
      await failed(
        lane,
        `${what.problem} Settle it by hand on ${lane.branch}; the lane goes on by itself afterwards.`,
      );
      return;
    }
    const attempts = lane.syncAttempts + 1;
    if (attempts > LANE_SYNC_MAX_ATTEMPTS) {
      await failed(
        lane,
        `${what.problem} The agent did not settle it in ${LANE_SYNC_MAX_ATTEMPTS} attempts.`,
      );
      return;
    }
    const scratch = laneSyncBranch(lane);
    if (lane.syncThreadId) {
      // The turn that just ended: the follow-up's turn ends at another time.
      const turn = await agent.turn(lane.syncThreadId);
      if (!(await agent.followUp(lane.syncThreadId, what.ask, scratch))) {
        await failed(lane, `${what.problem} The agent's thread could not be continued.`);
        return;
      }
      await move(lane, event, {
        syncAttempts: attempts,
        syncTurnAt: turn?.completedAt ?? null,
        syncError: null,
      });
      return;
    }
    const started = await agent.start({
      title: `[Factory sync] ${lane.branch}`.slice(0, 200),
      prompt: what.ask,
      branch: scratch,
      baseBranch: lane.branch,
    });
    if ('error' in started) {
      await failed(lane, `${what.problem} The agent could not start: ${started.error}`);
      return;
    }
    await move(lane, event, {
      syncThreadId: started.threadId,
      syncAttempts: attempts,
      syncTurnAt: null,
      syncError: null,
    });
  }

  /**
   * The agent's turn: nothing while it works; once it ended, back to the
   * checks when the scratch branch contains the base, else another attempt.
   * A turn is judged once (`syncTurnAt`): the follow-up's turn ends later.
   */
  async function whenResolving(lane: FactoryLaneView): Promise<void> {
    const sha = lane.syncBaseSha;
    if (!deps.agent || !lane.syncThreadId || !sha) {
      await failed(lane, 'The sync lost its agent. Retry it.');
      return;
    }
    const turn = await deps.agent.turn(lane.syncThreadId);
    if (!turn) {
      await failed(lane, "The sync agent's thread is gone. Retry the sync.");
      return;
    }
    const judged = turn.completedAt !== null && turn.completedAt === lane.syncTurnAt;
    if (!ENDED_THREAD.has(turn.status) || judged) {
      const started = lane.syncStartedAt ? Date.parse(lane.syncStartedAt) : now();
      if (now() - started > LANE_SYNC_AGENT_LIMIT_MS) {
        await failed(lane, 'The sync agent did not finish in time.');
      }
      return;
    }
    const from = (await deps.baseBranch()) ?? 'the base branch';
    const scratch = laneSyncBranch(lane);
    const pushed = await contains(scratch, sha);
    if (pushed === null) return;
    if (pushed) {
      const number = lane.syncPrNumber ?? (await openSyncPullRequest(lane, from));
      if (number !== null) await move(lane, 'resolved', { syncPrNumber: number });
      return;
    }
    await askAgent(lane, 'again', {
      from,
      problem: `The agent's turn ended (${turn.status}) and ${scratch} does not contain ${from} yet.`,
      ask: [
        `The branch \`${scratch}\` on origin still does not contain \`origin/${from}\` (commit ${sha}): the merge was not pushed.`,
        RULES,
      ].join('\n\n'),
    });
  }

  return { openSyncPullRequest, askAgent, whenResolving };
}

export function createLaneSync(deps: LaneSyncDeps, target: LaneSyncTarget) {
  const now = deps.now ?? Date.now;
  const { repo } = target.reader;

  async function move(
    lane: FactoryLaneView,
    event: LaneSyncEvent,
    changes: Parameters<FactoryLanesRepository['moveSync']>[2] = {},
  ): Promise<boolean> {
    const moved = await deps.lanes.moveSync(lane.id, LANE_SYNC_TRANSITIONS[event], changes);
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
  }

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

  const { openSyncPullRequest, askAgent, whenResolving } = createLaneSyncAgent({
    deps,
    now,
    move,
    failed,
    contains,
  });

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
      syncTurnAt: null,
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
      await askAgent(lane, 'conflict', {
        from,
        problem: `Merging ${from} into ${lane.branch} conflicts.`,
        ask: [
          `Merge \`origin/${from}\` (commit ${sha}) into this branch, \`${scratch}\`. It conflicts: settle each conflict so that both sides' changes still do what they were meant to.`,
          RULES,
        ].join('\n\n'),
      });
      return;
    }
    if (merged.value === 'nothing') {
      await move(lane, 'nothing', { lastSyncedBaseSha: sha, syncBaseSha: null });
      return;
    }
    const number = await openSyncPullRequest(lane, from);
    if (number !== null) await move(lane, 'clean', { syncPrNumber: number });
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
    if (ci.value.kind === 'failing') {
      // Failing checks are code: the agent's, like a conflict.
      const from = (await deps.baseBranch()) ?? 'the base branch';
      const failing = ci.value.checks
        .map((check) => `- ${check.name}${check.excerpt ? `\n${check.excerpt}` : ''}`)
        .join('\n');
      await askAgent(lane, 'red', {
        from,
        problem: checksProblem(lane, ci.value) ?? 'The checks of the sync pull request fail.',
        ask: [
          `After merging \`origin/${from}\` into \`${laneSyncBranch(lane)}\`, these checks of its pull request #${pr.number} fail:`,
          failing,
          'Fix what the merge broke on this branch.',
          RULES,
        ].join('\n\n'),
      });
      return;
    }
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
      case 'resolving':
        return whenResolving(lane);
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
