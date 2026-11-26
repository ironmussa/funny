/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: domain-service
 * @domain layer: domain
 *
 * The daily cross-lane conflict check (openspec factory-lanes D7): once a day,
 * for a factory with two or more active lanes, the enabler's runner tries
 * `git merge-tree` on each pair of lane branches, writing nothing to any
 * branch, and each lane stores which other lanes it conflicts with and on
 * which paths. The settings' lanes table and the board show them.
 *
 * The check is read-only and idempotent, so two server instances running it
 * at once only repeat it. A failure (runner offline) is retried after an hour,
 * not on every tick; an old git on the runner is stored as the lane's note and
 * waits a full day like a check that ran.
 */

import type { FactoryLaneConflict } from '@funny/shared/contracts/factory';
import type { Result } from 'neverthrow';

import { log } from '../../lib/logger.js';
import type { FactoryLanesRepository, FactoryLaneView } from './factory-lanes.js';
import type { LaneConflictsAnswer } from './factory-runner-jobs.js';

/** How often a factory's lanes are checked against each other. */
export const LANE_CONFLICT_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** How long a check that could not reach the runner waits before the next try. */
export const LANE_CONFLICT_RETRY_MS = 60 * 60 * 1000;

export interface LaneConflictCheckDeps {
  lanes: Pick<FactoryLanesRepository, 'list' | 'setConflicts'>;
  /** Run the check on the enabler's runner for these branches. */
  check: (branches: string[]) => Promise<Result<LaneConflictsAnswer, string>>;
  now?: () => number;
  /** Factory id → when its last check failed. In memory: a restart may retry sooner. */
  failedAt: Map<string, number>;
}

export type LaneConflictCheckOutcome = 'not-due' | 'checked' | 'unavailable' | 'failed';

const activeLanes = (lanes: readonly FactoryLaneView[]) =>
  lanes.filter((lane) => lane.state === 'active');

/** Whether the lanes need a check: two or more active, and one never checked or not for a day. */
export function isLaneConflictCheckDue(lanes: readonly FactoryLaneView[], now: number): boolean {
  const active = activeLanes(lanes);
  if (active.length < 2) return false;
  return active.some(
    (lane) =>
      !lane.conflictsCheckedAt ||
      now - Date.parse(lane.conflictsCheckedAt) >= LANE_CONFLICT_CHECK_INTERVAL_MS,
  );
}

/** Each lane's conflicts, by the other lane's name, from the pairs of branches that conflict. */
export function conflictsByLane(
  lanes: readonly FactoryLaneView[],
  pairs: readonly { a: string; b: string; paths: string[] }[],
): Map<string, FactoryLaneConflict[]> {
  const nameOf = new Map(lanes.map((lane) => [lane.branch, lane.name]));
  const byLane = new Map<string, FactoryLaneConflict[]>(lanes.map((lane) => [lane.name, []]));
  for (const pair of pairs) {
    const a = nameOf.get(pair.a);
    const b = nameOf.get(pair.b);
    if (!a || !b) continue;
    byLane.get(a)?.push({ lane: b, paths: pair.paths });
    byLane.get(b)?.push({ lane: a, paths: pair.paths });
  }
  return byLane;
}

async function store(
  deps: LaneConflictCheckDeps,
  lanes: readonly FactoryLaneView[],
  checkedAt: string,
  answer: LaneConflictsAnswer,
): Promise<void> {
  const byLane = answer.kind === 'checked' ? conflictsByLane(lanes, answer.conflicts) : null;
  const missing = new Set(answer.kind === 'checked' ? answer.missing : []);
  for (const lane of lanes) {
    const note =
      answer.kind === 'unavailable'
        ? answer.reason
        : missing.has(lane.branch)
          ? `The branch ${lane.branch} is not on the remote yet`
          : null;
    const stored = await deps.lanes.setConflicts(lane.id, {
      conflicts: byLane ? (byLane.get(lane.name) ?? []) : null,
      checkedAt,
      note,
    });
    if (stored.isErr()) {
      log.warn('Issue factory could not store a lane conflict check', {
        namespace: 'factory',
        laneId: lane.id,
        error: stored.error.message,
      });
    }
  }
}

/** Run the factory's cross-lane conflict check when it is due, and store what it found. */
export async function checkLaneConflicts(
  deps: LaneConflictCheckDeps,
  factoryId: string,
): Promise<LaneConflictCheckOutcome> {
  const now = (deps.now ?? Date.now)();
  const failed = deps.failedAt.get(factoryId);
  if (failed !== undefined && now - failed < LANE_CONFLICT_RETRY_MS) return 'not-due';

  const listed = await deps.lanes.list(factoryId);
  if (listed.isErr() || !isLaneConflictCheckDue(listed.value, now)) return 'not-due';
  const lanes = activeLanes(listed.value);

  const answer = await deps.check(lanes.map((lane) => lane.branch));
  if (answer.isErr()) {
    deps.failedAt.set(factoryId, now);
    log.warn('Issue factory cross-lane conflict check failed', {
      namespace: 'factory',
      factoryId,
      error: answer.error,
    });
    return 'failed';
  }
  deps.failedAt.delete(factoryId);
  await store(deps, lanes, new Date(now).toISOString(), answer.value);

  const outcome = answer.value.kind === 'checked' ? 'checked' : 'unavailable';
  log.info('Issue factory checked its lanes against each other', {
    namespace: 'factory',
    factoryId,
    lanes: lanes.length,
    outcome,
    conflicts: answer.value.kind === 'checked' ? answer.value.conflicts.length : undefined,
  });
  return outcome;
}
