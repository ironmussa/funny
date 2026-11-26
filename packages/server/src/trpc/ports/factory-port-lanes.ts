/**
 * The parallel-lane methods of the `factory` tRPC port (`factory.ts`), each
 * audited when it changes something (openspec factory-lanes).
 */

import { failure, type ApiFailure, type FactoryPort } from '@funny/api';
import type {
  FactoryLane,
  FactoryLaneConflict,
  FactoryLaneSyncState,
  FactoryQueueRun,
} from '@funny/shared/contracts/factory';
import { errAsync, okAsync, ResultAsync } from 'neverthrow';

import { audit } from '../../lib/audit.js';
import { serverActivities } from '../../services/activities/server-activities.js';
import type { FactoryGithubPort } from '../../services/factory/factory-github.js';
import { createLaneFinish } from '../../services/factory/factory-lane-finish.js';
import {
  createFactoryLanesRepository,
  type FactoryLanesRepository,
  type FactoryLaneView,
} from '../../services/factory/factory-lanes.js';
import { openRunsOfLane, requestLaneSync } from '../../services/factory/factory-settings.js';
import { factoryGithubPort, pokeFactory } from '../../services/factory/factory-watcher.js';
import { settingsFailure, type FactoryPortDeps } from './factory-port-shared.js';

const SYNC_STATES: readonly FactoryLaneSyncState[] = [
  'idle',
  'merging',
  'resolving',
  'checking',
  'needs_human',
];

const toSyncState = (value: string): FactoryLaneSyncState =>
  SYNC_STATES.find((state) => state === value) ?? 'idle';

const prUrl = (repo: string | null, number: number | null): string | null =>
  repo && number !== null ? `https://github.com/${repo}/pull/${number}` : null;

function toLaneContract(
  lane: FactoryLaneView,
  labelPrefix: string,
  openRuns: string[],
  repo: string | null,
): FactoryLane {
  return {
    id: lane.id,
    name: lane.name,
    label: `${labelPrefix}${lane.name}`,
    branch: lane.branch,
    state: lane.state,
    openRuns,
    ciWarning: lane.ciWarning,
    createdAt: lane.createdAt,
    syncState: toSyncState(lane.syncState),
    syncPrNumber: lane.syncPrNumber,
    syncPrUrl: prUrl(repo, lane.syncPrNumber),
    syncThreadId: lane.syncThreadId,
    syncAttempts: lane.syncAttempts,
    syncStartedAt: lane.syncStartedAt,
    syncError: lane.syncError,
    lastSyncedBaseSha: lane.lastSyncedBaseSha,
    finishPrNumber: lane.finishPrNumber,
    finishPrUrl: prUrl(repo, lane.finishPrNumber),
    conflicts: lane.conflicts,
    conflictsCheckedAt: lane.conflictsCheckedAt,
    conflictsNote: lane.conflictsNote,
  };
}

export interface LanePortOverrides {
  github?: () => FactoryGithubPort | null;
  lanes?: ReturnType<typeof createFactoryLanesRepository>;
  wake?: (factoryId: string) => void;
}

/** The lane methods of the factory port. */
export function lanePortMethods(
  { settings }: FactoryPortDeps,
  overrides: LanePortOverrides = {},
): Pick<FactoryPort, 'lanes' | 'removeLane' | 'syncLane' | 'finishLane'> {
  const getGithub = overrides.github ?? factoryGithubPort;
  const lanesRepo = overrides.lanes ?? createFactoryLanesRepository();
  const wake = overrides.wake ?? pokeFactory;

  return {
    async lanes(userId, projectId) {
      return settings
        .get(userId, projectId)
        .mapErr(settingsFailure)
        .andThen((view) => {
          if (!view) return okAsync<FactoryLane[], ApiFailure>([]);
          return settings
            .lanes(userId, projectId)
            .mapErr(settingsFailure)
            .andThen((rows) => {
              if (rows.length === 0) return okAsync<FactoryLane[], ApiFailure>([]);
              const github = getGithub();
              return ResultAsync.fromSafePromise(
                github ? github.resolveRepo(userId, projectId) : Promise.resolve(null),
              ).andThen((repo) =>
                ResultAsync.combine(
                  rows.map((lane) =>
                    openRunsOfLane(lane)
                      .mapErr(settingsFailure)
                      .map((open) => toLaneContract(lane, view.laneLabelPrefix, open, repo)),
                  ),
                ),
              );
            });
        });
    },

    async removeLane(userId, projectId, name) {
      return settings
        .removeLane(userId, projectId, name)
        .mapErr(settingsFailure)
        .map(() => {
          audit({
            action: 'factory.lane_removed',
            actorId: userId,
            detail: `Removed lane ${name} from the factory of project ${projectId}`,
            meta: { projectId, lane: name },
          });
          return { ok: true as const };
        });
    },

    async syncLane(userId, projectId, name) {
      return requestLaneSync(userId, projectId, name)
        .mapErr(settingsFailure)
        .andThen((outcome) =>
          settings
            .factoryId(userId, projectId)
            .mapErr(settingsFailure)
            .map((factoryId) => {
              if (factoryId && outcome !== 'in-flight') wake(factoryId);
              audit({
                action: 'factory.lane_sync_requested',
                actorId: userId,
                detail: `Requested sync for lane ${name} of project ${projectId} (${outcome})`,
                meta: { projectId, lane: name, outcome },
              });
              return { outcome };
            }),
        );
    },

    async finishLane(userId, projectId, name) {
      const github = getGithub();
      if (!github) {
        return errAsync(
          failure(503, "The project's repository could not be reached now. Try again."),
        );
      }
      return createLaneFinish({ github, lanes: lanesRepo, activities: serverActivities })
        .finish(userId, projectId, name)
        .mapErr(settingsFailure)
        .andThen((result) =>
          settings
            .factoryId(userId, projectId)
            .mapErr(settingsFailure)
            .map((factoryId) => {
              if (factoryId) wake(factoryId);
              audit({
                action: 'factory.lane_finished',
                actorId: userId,
                detail: `Opened finish PR #${result.prNumber} for lane ${result.lane} of project ${projectId}`,
                meta: {
                  projectId,
                  lane: result.lane,
                  branch: result.branch,
                  base: result.base,
                  prNumber: result.prNumber,
                },
              });
              return result;
            }),
        );
    },
  };
}

/**
 * The queue's runs, each run in a lane with the lanes its lane conflicts with
 * (D7). One read of the lanes per factory; a failed read leaves those runs as
 * they are.
 */
export async function withLaneConflicts<R extends FactoryQueueRun & { factoryId: string }>(
  runs: R[],
  lanes: Pick<FactoryLanesRepository, 'list'> = createFactoryLanesRepository(),
): Promise<R[]> {
  const factoryIds = [...new Set(runs.flatMap((run) => (run.lane ? [run.factoryId] : [])))];
  const conflicts = new Map<string, FactoryLaneConflict[]>();
  for (const factoryId of factoryIds) {
    const listed = await lanes.list(factoryId);
    if (listed.isErr()) continue;
    for (const lane of listed.value) {
      if (lane.conflicts?.length) conflicts.set(`${factoryId}\u0000${lane.name}`, lane.conflicts);
    }
  }
  if (conflicts.size === 0) return runs;
  return runs.map((run) => {
    const found = run.lane ? conflicts.get(`${run.factoryId}\u0000${run.lane}`) : undefined;
    return found ? { ...run, laneConflicts: found } : run;
  });
}
