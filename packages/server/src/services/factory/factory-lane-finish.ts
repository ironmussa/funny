/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: application-service
 * @domain layer: application
 *
 * Finishing a lane (openspec factory-lanes, D8): the factory opens the pull
 * request that merges the lane's branch into the branch the factory merges
 * into, and stops there. A person reviews and merges it: it carries a whole
 * feature, including what an agent wrote to settle a sync. It is not a factory
 * run, so nothing classes its risk, approves it or merges it.
 *
 * `watchFinishedLanes` is the other half, on the watcher's tick: once that
 * pull request merged, the lane is marked finished, so its label sends later
 * issues to the factory's own branch and it is not synced any more.
 */
import { and, asc, eq } from 'drizzle-orm';
import { errAsync, okAsync, ResultAsync } from 'neverthrow';

import { db } from '../../db/index.js';
import { factoryRuns } from '../../db/schema.js';
import { log } from '../../lib/logger.js';
import type { ServerActivities } from '../activities/server-activities.js';
import type { FactoryGithubPort, FactoryRepoReader } from './factory-github.js';
import type { FactoryLanesRepository, FactoryLaneView } from './factory-lanes.js';
import {
  openRunsOfLane,
  ownLane,
  requestLaneSync,
  type FactorySettingsError,
} from './factory-settings.js';

export interface FinishLaneDeps {
  github: Pick<
    FactoryGithubPort,
    'resolveRepo' | 'defaultBranch' | 'laneBranches' | 'pullRequests'
  >;
  lanes: Pick<FactoryLanesRepository, 'list' | 'setFinishPullRequest' | 'markFinished'>;
  /** Records opening the finish pull request and marking the lane finished. */
  activities?: Pick<ServerActivities, 'recordServerActivity'>;
}

export interface FinishedLane {
  lane: string;
  branch: string;
  /** The branch the pull request merges into. */
  base: string;
  prNumber: number;
  prUrl: string;
}

const invalid = (message: string): FactorySettingsError => ({ kind: 'invalid', message });

/** The issues the lane's runs merged, oldest first, as lines of a pull request body. */
async function mergedIssueLines(lane: FactoryLaneView): Promise<string[]> {
  const rows = await db
    .select({ issueNumber: factoryRuns.issueNumber, issueTitle: factoryRuns.issueTitle })
    .from(factoryRuns)
    .where(
      and(
        eq(factoryRuns.factoryId, lane.factoryId),
        eq(factoryRuns.lane, lane.name),
        eq(factoryRuns.state, 'merged'),
      ),
    )
    .orderBy(asc(factoryRuns.completedAt));
  const seen = new Set<number>();
  return rows.flatMap((row) => {
    if (row.issueNumber <= 0 || seen.has(row.issueNumber)) return [];
    seen.add(row.issueNumber);
    return [`- #${row.issueNumber}${row.issueTitle ? ` ${row.issueTitle}` : ''}`];
  });
}

const finishBody = (lane: FactoryLaneView, base: string, issues: string[]): string =>
  [
    `The issue factory developed this feature on the lane \`${lane.branch}\`. This pull request merges it into \`${base}\`.`,
    '',
    '**A person must review and merge it.** The factory does not merge it, and it was not reviewed as a whole: each task was reviewed on its own, and a sync an agent settled was not reviewed at all.',
    '',
    issues.length > 0 ? 'Issues merged into the lane:' : 'No issue was merged into the lane yet.',
    ...issues,
  ].join('\n');

export function createLaneFinish(deps: FinishLaneDeps) {
  return {
    /**
     * Open the lane's final pull request, as the member who asks (`steer`, the
     * member's own factory). Refused while a run of the lane has not ended.
     * Asking again answers the pull request that is open already.
     */
    finish(
      userId: string,
      projectId: string,
      name: string,
    ): ResultAsync<FinishedLane, FactorySettingsError> {
      return ownLane(userId, projectId, name).andThen((lane) => {
        if (lane.state !== 'active') {
          return errAsync<FinishedLane, FactorySettingsError>(
            invalid(`The lane ${lane.name} is finished already`),
          );
        }
        return openRunsOfLane(lane).andThen((open) =>
          open.length > 0
            ? errAsync<FinishedLane, FactorySettingsError>(
                invalid(
                  `The lane ${lane.name} still has runs that have not ended (${open.join(', ')}): stop or finish them first`,
                ),
              )
            : ResultAsync.fromSafePromise(openFinal(userId, projectId, lane)).andThen((result) =>
                'error' in result
                  ? errAsync<FinishedLane, FactorySettingsError>(invalid(result.error))
                  : okAsync<FinishedLane, FactorySettingsError>(result),
              ),
        );
      });
    },
  };

  async function openFinal(
    userId: string,
    projectId: string,
    lane: FactoryLaneView,
  ): Promise<FinishedLane | { error: string }> {
    const repo = await deps.github.resolveRepo(userId, projectId);
    if (!repo || !deps.github.laneBranches) {
      return { error: "The project's repository could not be reached now. Try again." };
    }
    const reader: FactoryRepoReader = { repo, ownerId: userId, projectId };
    const base = await deps.github.defaultBranch(reader);
    if (base.isErr()) return { error: `GitHub could not be read: ${base.error.message}` };
    const opened = await deps.github.laneBranches(reader).openPullRequest({
      head: lane.branch,
      base: base.value,
      title: `Finish ${lane.name}: merge ${lane.branch} into ${base.value}`,
      body: finishBody(lane, base.value, await mergedIssueLines(lane)),
    });
    if (opened.isErr()) {
      return {
        error: `The pull request could not be opened: ${opened.error.detail ?? opened.error.message}`,
      };
    }
    await deps.lanes.setFinishPullRequest(lane.id, opened.value);
    // Bring the base in now, so what a person reviews is the feature alone.
    await requestLaneSync(userId, projectId, lane.name);
    log.info('Issue factory lane finish asked', {
      namespace: 'factory',
      factoryId: lane.factoryId,
      lane: lane.name,
      prNumber: opened.value,
      userId,
    });
    const prUrl = `https://github.com/${repo}/pull/${opened.value}`;
    await deps.activities?.recordServerActivity(
      {
        kind: 'factory.finish_lane',
        userId,
        projectId,
        title: `Opened finish pull request #${opened.value} for lane ${lane.name}`,
        input: {
          lane: lane.name,
          branch: lane.branch,
          base: base.value,
          prNumber: opened.value,
          stage: 'opened',
        },
        origin: 'user',
      },
      { ok: true, effects: [], resultRef: { prUrl } },
    );
    return {
      lane: lane.name,
      branch: lane.branch,
      base: base.value,
      prNumber: opened.value,
      prUrl,
    };
  }
}

/**
 * Mark finished the factory's lanes whose final pull request merged; one
 * closed without merging is forgotten, so the member can ask again.
 */
export async function watchFinishedLanes(
  deps: FinishLaneDeps,
  target: { factoryId: string; reader: FactoryRepoReader },
): Promise<void> {
  const lanes = await deps.lanes.list(target.factoryId);
  if (lanes.isErr()) return;
  for (const lane of lanes.value) {
    if (lane.state !== 'active' || lane.finishPrNumber === null) continue;
    const state = await deps.github.pullRequests.prState({
      repo: target.reader.repo,
      number: lane.finishPrNumber,
      userId: target.reader.ownerId,
      projectId: target.reader.projectId,
    });
    if (state.isErr() || state.value === 'open') continue;
    if (state.value === 'closed') {
      await deps.lanes.setFinishPullRequest(lane.id, null);
      continue;
    }
    const finished = await deps.lanes.markFinished(lane.id);
    if (finished.isOk() && finished.value) {
      log.info('Issue factory lane finished', {
        namespace: 'factory',
        factoryId: target.factoryId,
        lane: lane.name,
        prNumber: lane.finishPrNumber,
      });
      await deps.activities?.recordServerActivity(
        {
          kind: 'factory.finish_lane',
          userId: target.reader.ownerId,
          projectId: target.reader.projectId,
          title: `Lane ${lane.name} finished (PR #${lane.finishPrNumber} merged)`,
          input: {
            lane: lane.name,
            branch: lane.branch,
            prNumber: lane.finishPrNumber,
            stage: 'finished',
          },
          origin: 'system',
        },
        { ok: true, effects: [] },
      );
    }
  }
}
