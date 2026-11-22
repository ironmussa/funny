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
export const MAX_BASE_UPDATES = 5;

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

export interface MergeLaneDeps {
  prs: Pick<
    FactoryPullRequests,
    'pullHead' | 'baseDistance' | 'updateBranch' | 'commitParents' | 'baseChanges' | 'changedFiles'
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
export function conflictFeedback(input: {
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
export function staleChecksFeedback(baseRef: string, checksError: string): string {
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

  return {
    /**
     * Bring the pull request up to date with its base and make sure its checks
     * are green there. Resolves with the head that is current, or why not.
     */
    async bringUpToDate(): Promise<UpToDate> {
      const pr = deps.pullRequest();
      if (!pr) return { kind: 'failed', error: 'The run has no pull request yet.' };
      const carried: Array<{ from: string; to: string }> = [];
      for (let update = 0; update <= MAX_BASE_UPDATES; update++) {
        if (deps.signal.aborted) return { kind: 'failed', error: 'The run was stopped.' };
        const head = await deps.prs.pullHead(pr);
        if (head.isErr()) return { kind: 'failed', error: head.error.message };
        const { sha, baseRef } = head.value;
        const distance = await deps.prs.baseDistance(pr, baseRef, sha);
        if (distance.isErr()) return { kind: 'failed', error: distance.error.message };
        if (distance.value.behindBy === 0) return { kind: 'current', sha, carried };
        if (update === MAX_BASE_UPDATES) break;

        const step = await mergeBaseIn(pr, baseRef, sha);
        if ('kind' in step) return step;
        if ('retry' in step) continue;
        carried.push({ from: sha, to: step.updated });

        // The checks that were green ran on the old base: wait for them on the new head.
        const checks = await deps.waitChecks();
        if (checks.ok) continue;
        const verdict = checks.metadata?.verdict;
        if (verdict === 'conflict') return conflict(pr, baseRef, step.updated);
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
        kind: 'failed',
        error: `The base branch kept moving: the pull request was brought up to date ${MAX_BASE_UPDATES} times and is still behind.`,
      };
    },
  };
}
