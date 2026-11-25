/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: application-service
 * @domain layer: application
 *
 * Bringing a run's pull request up to date before it merges (change
 * factory-agent-roles, D8, D9). `merge` holds the repository's lane, so this
 * is the only factory merge in progress there. Green checks on an old base
 * prove nothing about the base as it is now:
 *
 * 1. While the head is behind its base branch, GitHub merges the base in
 *    (update-branch: a merge commit, never a rebase), and the checks are
 *    waited on again for the new head.
 * 2. A new head made this way keeps the review of the commit it was made
 *    from, when it is exactly a merge of that commit with a commit of the
 *    base: the pull request's own change is the same.
 * 3. A conflict, or checks that fail on the updated branch, is code: it is
 *    sent back to the implementing agent with what the base gained. Anything
 *    else that stops it (a refusal, a timeout, an unreadable answer) fails the
 *    step, and the run waits for a person.
 *
 * The server never rebases or force-pushes, and never resolves a conflict.
 */

import type { BaseChanges, PullRequestFiles } from '@funny/core/github-app';
import { sleep as interruptibleSleep } from '@funny/shared/async';
import type { ActionResult } from '@funny/workflows/compiler';

import type { FactoryPullRequestRef, FactoryPullRequests } from './factory-pull-requests.js';

/** The base is merged in at most this many times in one visit of `merge`. */
const MAX_BASE_UPDATES = 5;

/** How long GitHub may take to put the update-branch merge commit on the branch. */
const NEW_HEAD_TIMEOUT_MS = 2 * 60 * 1000;
const NEW_HEAD_INTERVAL_MS = 2 * 1000;

const LOCKFILE =
  /(^|\/)(bun\.lockb?|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|uv\.lock|Gemfile\.lock|go\.sum|composer\.lock)$/;
const MIGRATION = /(^|\/)migrations?\/|(^|\/)migrate\.[cm]?[jt]s$/;

export type UpToDate =
  /** The head is up to date with its base. `carried`: each update-branch step that kept its review. */
  | { kind: 'current'; sha: string; carried: Array<{ from: string; to: string }> }
  /** Code stands in the way: the implementing agent gets `feedback`. */
  | { kind: 'sent-back'; why: 'conflict' | 'checks'; feedback: string }
  /** It could not be brought up to date and no code change is known to help. */
  | { kind: 'failed'; error: string };

/** How a pull request left GitHub's merge queue. */
export type QueueEnd =
  /** GitHub merged it. */
  | { kind: 'merged' }
  /** GitHub took it out without merging: its checks failed with the base, or it conflicts. */
  | { kind: 'removed' }
  | { kind: 'failed'; error: string };

/** How often the queue is looked at, and how long a pull request may stay in it. */
const QUEUE_INTERVAL_MS = 30 * 1000;
/**
 * GitHub errors in a row the queue watch rides out (a dropped connection, a
 * 5xx) before it gives up. Seen in a real run: one reset connection ten seconds
 * after the queue merged the pull request ended the run as failed.
 */
const QUEUE_READ_RETRIES = 5;
const QUEUE_TIMEOUT_MS = 2 * 60 * 60 * 1000;

/** Merge queue state → where it leaves the pull request, for the final states only. */
interface QueueEnds {
  [state: string]: QueueEnd | undefined;
}

/** Where each final queue state leaves the pull request (`queued` is not final). */
const QUEUE_ENDS: QueueEnds = {
  merged: { kind: 'merged' },
  'not-queued': { kind: 'removed' },
  closed: { kind: 'failed', error: 'The pull request was closed while in the merge queue.' },
};

export interface MergeLaneDeps {
  prs: Pick<
    FactoryPullRequests,
    | 'pullHead'
    | 'baseDistance'
    | 'updateBranch'
    | 'commitParents'
    | 'baseChanges'
    | 'changedFiles'
    | 'enqueue'
    | 'queueState'
  >;
  pullRequest(): FactoryPullRequestRef | null;
  /** The run's branch (named in the feedback). */
  branch: string;
  signal: AbortSignal;
  /** Wait for the checks of the pull request's head, as the flow's `wait_ci` does. */
  waitChecks(): Promise<ActionResult>;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

const listed = (items: string[], max: number) => {
  const shown = items.slice(0, max).map((item) => `- ${item}`);
  if (items.length > max) shown.push(`- … and ${items.length - max} more`);
  return shown.join('\n');
};

/**
 * What the implementing agent is told about a conflict: what the base gained,
 * the files both sides changed, and the kinds of file that are not merged by
 * hand (a lockfile is regenerated, a numbered migration is renumbered).
 */
function conflictFeedback(input: {
  branch: string;
  baseRef: string;
  changes: BaseChanges | null;
  prFiles: PullRequestFiles | null;
}): string {
  const { branch, baseRef, changes, prFiles } = input;
  const mine = new Set((prFiles?.files ?? []).map((file) => file.path));
  const both = (changes?.files ?? []).filter((file) => mine.has(file));
  const parts = [
    `The pull request from \`${branch}\` conflicts with \`${baseRef}\`: other changes merged first and GitHub cannot merge \`${baseRef}\` into the branch cleanly.`,
  ];
  if (changes && changes.commits.length > 0) {
    parts.push(
      `Merged into \`${baseRef}\` since your branch last had it:\n${listed(
        changes.commits.map((commit) => `${commit.sha.slice(0, 8)} ${commit.title}`),
        20,
      )}`,
    );
  }
  if (both.length > 0) {
    parts.push(
      `Files changed on both sides (where the conflicts are likely):\n${listed(both, 30)}`,
    );
  }
  const baseMigrations = (changes?.files ?? []).some((file) => MIGRATION.test(file));
  const ownMigrations = [...mine].some((file) => MIGRATION.test(file));
  const fileRules = [
    both.some((file) => LOCKFILE.test(file))
      ? "A lockfile changed on both sides: do not merge it by hand. Take the base branch's version and regenerate it with the package manager."
      : null,
    baseMigrations && ownMigrations
      ? 'Migrations merged first: keep theirs as they are and renumber yours so it comes after them.'
      : null,
  ].filter(Boolean);
  if (fileRules.length > 0) parts.push(fileRules.join('\n'));
  parts.push(
    `Run \`git fetch origin\`, check out \`${branch}\`, and merge \`origin/${baseRef}\` into it. Read what the other changes did (\`git log -p HEAD..origin/${baseRef} -- <file>\`) before resolving, so both changes keep working. Never rebase and never force push: the branch's reviewed commits must stay in its history.`,
  );
  return parts.join('\n\n');
}

/** What the implementing agent is told when the checks fail on the updated branch. */
function staleChecksFeedback(baseRef: string, checksError: string): string {
  return [
    `Your change passed its checks before, but after \`${baseRef}\` was merged into the branch they fail: something that merged first does not work together with your change.`,
    checksError,
  ].join('\n\n');
}

export function createMergeLane(deps: MergeLaneDeps) {
  const sleep = deps.sleep ?? interruptibleSleep;
  const now = deps.now ?? Date.now;

  /** The pull request's head once it is no longer `sha`, or null when it never changed. */
  async function newHeadAfter(pr: FactoryPullRequestRef, sha: string): Promise<string | null> {
    const started = now();
    while (now() - started < NEW_HEAD_TIMEOUT_MS) {
      const head = await deps.prs.pullHead(pr);
      if (head.isOk() && head.value.sha !== sha) return head.value.sha;
      const slept = await sleep(NEW_HEAD_INTERVAL_MS, deps.signal).then(
        () => true,
        () => false,
      );
      if (!slept || deps.signal.aborted) return null;
    }
    return null;
  }

  /**
   * Whether `updated` is exactly a merge of `from` with a commit of the base:
   * two parents, one of them `from`, the other with nothing the base lacks.
   */
  async function isBaseMerge(
    pr: FactoryPullRequestRef,
    baseRef: string,
    from: string,
    updated: string,
  ): Promise<boolean> {
    const parents = await deps.prs.commitParents(pr, updated);
    if (parents.isErr() || parents.value.length !== 2 || !parents.value.includes(from)) {
      return false;
    }
    const other = parents.value.find((parent) => parent !== from);
    if (!other) return false;
    const distance = await deps.prs.baseDistance(pr, baseRef, other);
    return distance.isOk() && distance.value.aheadBy === 0;
  }

  async function conflict(
    pr: FactoryPullRequestRef,
    baseRef: string,
    sha: string,
  ): Promise<UpToDate> {
    const [changes, prFiles] = await Promise.all([
      deps.prs.baseChanges(pr, sha, baseRef),
      deps.prs.changedFiles(pr),
    ]);
    return {
      kind: 'sent-back',
      why: 'conflict',
      feedback: conflictFeedback({
        branch: deps.branch,
        baseRef,
        changes: changes.isOk() ? changes.value : null,
        prFiles: prFiles.isOk() ? prFiles.value : null,
      }),
    };
  }

  /** One update-branch step from `sha`: the new head it produced, or how it ended. */
  async function mergeBaseIn(
    pr: FactoryPullRequestRef,
    baseRef: string,
    sha: string,
  ): Promise<{ updated: string } | { retry: true } | UpToDate> {
    const asked = await deps.prs.updateBranch(pr, sha);
    if (asked.isErr()) return { kind: 'failed', error: asked.error.message };
    if (asked.value.kind === 'conflict') return conflict(pr, baseRef, sha);
    // Someone pushed meanwhile: look at the branch again.
    if (asked.value.kind === 'head-moved') return { retry: true };
    if (asked.value.kind === 'refused') {
      return {
        kind: 'failed',
        error: `GitHub refused to bring the branch up to date with ${baseRef}: ${asked.value.reason}`,
      };
    }
    const updated = await newHeadAfter(pr, sha);
    if (!updated) {
      return {
        kind: 'failed',
        error: `GitHub accepted bringing the branch up to date with ${baseRef}, but its merge commit never appeared.`,
      };
    }
    if (!(await isBaseMerge(pr, baseRef, sha, updated))) {
      return {
        kind: 'failed',
        error: `The branch changed while it was being brought up to date: its head ${updated} is not a merge of ${sha} with ${baseRef}.`,
      };
    }
    return { updated };
  }

  /**
   * One look at the queue: how the pull request left it, or null to look again.
   * `misses` counts the GitHub errors in a row; only those may pass (no access
   * or no installation will not), and only `QUEUE_READ_RETRIES` of them.
   */
  async function lookAtQueue(
    pr: FactoryPullRequestRef,
    misses: { count: number },
  ): Promise<QueueEnd | null> {
    const state = await deps.prs.queueState(pr);
    if (state.isOk()) {
      misses.count = 0;
      return QUEUE_ENDS[state.value] ?? null;
    }
    misses.count += 1;
    const passes = state.error.kind === 'github-error' && misses.count <= QUEUE_READ_RETRIES;
    return passes ? null : { kind: 'failed', error: state.error.message };
  }

  /** Look at the queue until GitHub merges the pull request or takes it out. */
  async function followQueue(pr: FactoryPullRequestRef): Promise<QueueEnd> {
    const started = now();
    const misses = { count: 0 };
    while (now() - started < QUEUE_TIMEOUT_MS) {
      if (deps.signal.aborted) return { kind: 'failed', error: 'The run was stopped.' };
      const end = await lookAtQueue(pr, misses);
      if (end) return end;
      const slept = await sleep(QUEUE_INTERVAL_MS, deps.signal).then(
        () => true,
        () => false,
      );
      if (!slept) return { kind: 'failed', error: 'The run was stopped.' };
    }
    return {
      kind: 'failed',
      error: `GitHub's merge queue did not merge the pull request within ${QUEUE_TIMEOUT_MS / 60_000} minutes.`,
    };
  }

  /**
   * One round of bringing the pull request up to date: its result, `again` for
   * another round, or `stop` when it is still behind on the last one.
   */
  async function updateOnce(
    pr: FactoryPullRequestRef,
    carried: Array<{ from: string; to: string }>,
    last: boolean,
    awaitChecks: boolean,
  ): Promise<UpToDate | 'again' | 'stop'> {
    if (deps.signal.aborted) return { kind: 'failed', error: 'The run was stopped.' };
    const position = await positionOf(pr);
    if ('error' in position) return { kind: 'failed', error: position.error };
    const { sha, baseRef, behindBy } = position;
    if (behindBy === 0) return { kind: 'current', sha, carried };
    if (last) return 'stop';
    const step = await mergeBaseIn(pr, baseRef, sha);
    if ('kind' in step) return step;
    if ('retry' in step) return 'again';
    carried.push({ from: sha, to: step.updated });
    if (!awaitChecks) return 'again';
    // The checks that were green ran on the old base: wait for them on the new head.
    return (await checksOnNewHead(pr, baseRef, step.updated)) ?? 'again';
  }

  /** The update rounds, each waiting for the new head's checks or not. */
  async function update(awaitChecks: boolean): Promise<UpToDate> {
    const pr = deps.pullRequest();
    if (!pr) return { kind: 'failed', error: 'The run has no pull request yet.' };
    const carried: Array<{ from: string; to: string }> = [];
    for (let round = 0; round <= MAX_BASE_UPDATES; round++) {
      const step = await updateOnce(pr, carried, round === MAX_BASE_UPDATES, awaitChecks);
      if (step === 'stop') break;
      if (step !== 'again') return step;
    }
    return {
      kind: 'failed',
      error: `The base branch kept moving: the pull request was brought up to date ${MAX_BASE_UPDATES} times and is still behind.`,
    };
  }

  /** The pull request's head, its base and how far behind the base it is. */
  async function positionOf(
    pr: FactoryPullRequestRef,
  ): Promise<{ sha: string; baseRef: string; behindBy: number } | { error: string }> {
    const head = await deps.prs.pullHead(pr);
    if (head.isErr()) return { error: head.error.message };
    const { sha, baseRef } = head.value;
    const distance = await deps.prs.baseDistance(pr, baseRef, sha);
    if (distance.isErr()) return { error: distance.error.message };
    return { sha, baseRef, behindBy: distance.value.behindBy };
  }

  /** The checks of a head just brought up to date: null when green, else why the merge stops. */
  async function checksOnNewHead(
    pr: FactoryPullRequestRef,
    baseRef: string,
    updated: string,
  ): Promise<UpToDate | null> {
    const checks = await deps.waitChecks();
    if (checks.ok) return null;
    const verdict = checks.metadata?.verdict;
    if (verdict === 'conflict') return conflict(pr, baseRef, updated);
    if (verdict === 'red') {
      return {
        kind: 'sent-back',
        why: 'checks',
        feedback: staleChecksFeedback(baseRef, checks.error ?? 'The checks failed.'),
      };
    }
    return { kind: 'failed', error: checks.error ?? 'The checks did not pass.' };
  }

  return {
    /**
     * Whether `to` is exactly a merge of `from` with a commit of the pull
     * request's base branch, so it holds what was proved of `from`.
     */
    async isBaseMergeOf(from: string, to: string): Promise<boolean> {
      const pr = deps.pullRequest();
      if (!pr) return false;
      const head = await deps.prs.pullHead(pr);
      if (head.isErr()) return false;
      return isBaseMerge(pr, head.value.baseRef, from, to);
    },

    /**
     * Where the base branch requires GitHub's merge queue: add the pull request
     * (only while its head is `sha`) and follow it. GitHub tests it on the
     * current base and merges it, so the branch is not updated first.
     */
    async throughQueue(sha: string): Promise<QueueEnd> {
      const pr = deps.pullRequest();
      if (!pr) return { kind: 'failed', error: 'The run has no pull request yet.' };
      const added = await deps.prs.enqueue(pr, sha);
      if (added.isErr()) return { kind: 'failed', error: added.error.message };
      if (added.value.kind === 'head-moved') {
        return {
          kind: 'failed',
          error: `The pull request head moved from ${sha} before it could enter the merge queue.`,
        };
      }
      if (added.value.kind === 'refused') {
        return {
          kind: 'failed',
          error: `GitHub refused to add the pull request to the merge queue: ${added.value.reason}`,
        };
      }
      return followQueue(pr);
    },

    /**
     * Which branch moved since `sha` was the head to merge: the pull request's
     * head, the base (the head is behind it), or neither. What tells a merge
     * GitHub refused in the moment a branch moved from one a rule refuses
     * (openspec factory-merge-fewer-bounces, D1). Null when it cannot say.
     */
    async movedSince(sha: string): Promise<'head' | 'base' | 'neither' | null> {
      const pr = deps.pullRequest();
      const position = pr ? await positionOf(pr) : null;
      if (!position || 'error' in position) return null;
      if (position.sha !== sha) return 'head';
      return position.behindBy > 0 ? 'base' : 'neither';
    },

    /**
     * Bring the pull request up to date with its base and make sure its checks
     * are green there. Resolves with the head that is current, or why not.
     */
    bringUpToDate(): Promise<UpToDate> {
      return update(true);
    },

    /**
     * Bring the pull request up to date with its base without waiting for the
     * new head's checks: what `merge` does before it parks a high-risk change
     * for a person, so the commit they approve already has the base. The
     * checks run while they decide, and the approved merge waits for them.
     */
    updateBase(): Promise<UpToDate> {
      return update(false);
    },
  };
}
