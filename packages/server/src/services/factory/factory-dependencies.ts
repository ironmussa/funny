/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: domain-service
 * @domain layer: domain
 *
 * Whether an issue may be admitted given its blockers (change
 * factory-manual-queue): GitHub's native "blocked by" relation, read by the
 * watcher. A blocker is finished when its issue is closed, or when this
 * factory has a run for it that merged (an agent that forgot `Closes #N` must
 * not block its dependents forever). Pure: the watcher supplies what it read.
 */

import type { IssueBlocker } from '@funny/core/github-app';
import type { FactoryWaitReason } from '@funny/shared/contracts/factory';

import type { FactoryRunState } from './factory-runs.js';

/** What the factory knows about one issue's runs: the latest one's state. */
export type LatestRunState = ReadonlyMap<number, FactoryRunState>;

export interface BlockerInput {
  /** The candidate's repository (`owner/name`, lowercase). */
  repo: string;
  issue: number;
  /** The candidate's blockers as GitHub answered, or null when they could not be read. */
  blockers: IssueBlocker[] | null;
  /** The latest run of each issue in this factory. */
  latestRuns: LatestRunState;
  /**
   * Unfinished same-repository blockers of the issues waiting in the queue,
   * as far as they were read: the edges the cycle check walks.
   */
  queueGraph: ReadonlyMap<number, readonly number[]>;
}

type BlockerStatus = Exclude<
  FactoryWaitReason['kind'],
  'circular' | 'blockers-unreadable' | 'proof-not-configured'
>;

/** The reasons shown first when several blockers hold the issue: the most actionable. */
const PRIORITY: BlockerStatus[] = [
  'blocker-not-sent',
  'blocker-failed',
  'blocker-waiting-merge',
  'blocker-in-progress',
  'blocker-other-repo',
];

const IN_PROGRESS: ReadonlySet<FactoryRunState> = new Set([
  'requested',
  'queued',
  'working',
  'pr_open',
  'waiting_ci',
  'fixing',
]);

/** Why one unfinished blocker of this repository holds the issue, from its latest run here. */
function statusOf(latest: FactoryRunState | undefined): BlockerStatus {
  if (latest === undefined) return 'blocker-not-sent';
  if (latest === 'waiting_human') return 'blocker-waiting-merge';
  if (IN_PROGRESS.has(latest)) return 'blocker-in-progress';
  return 'blocker-failed';
}

/** The open blockers of the same repository that have no merged run here: what holds the issue. */
export function unfinishedBlockers(
  repo: string,
  blockers: readonly IssueBlocker[],
  latestRuns: LatestRunState,
): { sameRepo: number[]; otherRepo: number[] } {
  const sameRepo: number[] = [];
  const otherRepo: number[] = [];
  for (const blocker of blockers) {
    if (!blocker.open) continue;
    if (blocker.repo !== repo) otherRepo.push(blocker.number);
    else if (latestRuns.get(blocker.number) !== 'merged') sameRepo.push(blocker.number);
  }
  return { sameRepo, otherRepo };
}

/** Whether `issue` reaches itself through the queue's blocker edges. */
export function inCycle(issue: number, graph: ReadonlyMap<number, readonly number[]>): boolean {
  const seen = new Set<number>();
  const stack = [...(graph.get(issue) ?? [])];
  while (stack.length > 0) {
    const next = stack.pop()!;
    if (next === issue) return true;
    if (seen.has(next)) continue;
    seen.add(next);
    stack.push(...(graph.get(next) ?? []));
  }
  return false;
}

/** Why the issue must wait, or null when every blocker is finished. */
export function waitReasonFor(input: BlockerInput): FactoryWaitReason | null {
  if (input.blockers === null) return { kind: 'blockers-unreadable', blockers: [] };
  const { sameRepo, otherRepo } = unfinishedBlockers(input.repo, input.blockers, input.latestRuns);
  if (sameRepo.length === 0 && otherRepo.length === 0) return null;
  if (inCycle(input.issue, input.queueGraph)) {
    return { kind: 'circular', blockers: sameRepo };
  }
  const byStatus = new Map<BlockerStatus, number[]>();
  for (const number of sameRepo) {
    const status = statusOf(input.latestRuns.get(number));
    byStatus.set(status, [...(byStatus.get(status) ?? []), number]);
  }
  if (otherRepo.length > 0) byStatus.set('blocker-other-repo', otherRepo);
  const kind = PRIORITY.find((status) => byStatus.has(status))!;
  return { kind, blockers: byStatus.get(kind)! };
}

/** Two wait reasons say the same thing (the watcher writes only a change). */
export const sameWaitReason = (a: FactoryWaitReason | null, b: FactoryWaitReason | null): boolean =>
  JSON.stringify(a) === JSON.stringify(b);
