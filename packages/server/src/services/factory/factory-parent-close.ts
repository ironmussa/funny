/**
 * Closing an issue whose work went to other issues (issue #464): triage split
 * it (`splitInto`) or found it tracked by existing issues (`existing`), and its
 * run ended `done` while the issue stayed open, so the issues it blocks waited
 * on a person to close it. Each watcher pass looks at those runs; once every
 * part is closed, the factory comments on the issue, closes it as completed
 * and marks the run (`triage.partsClosedAt`) so it is not looked at again. An
 * issue a person closed first is only marked.
 *
 * @domain subdomain: Issue Factory
 * @domain type: app-service
 * @domain layer: application
 */

import type { FactoryTriage } from '@funny/shared/contracts/factory';

import { log } from '../../lib/logger.js';
import type { ServerActivities } from '../activities/server-activities.js';
import type { FactoryGithubPort, FactoryRepoReader } from './factory-github.js';
import type { FactoryRunView } from './factory-runs.js';
import { delegatedWork } from './factory-watcher-admission.js';

const PARENT_CLOSED_LINE =
  'The issue factory closed this issue: every issue that carried its work is closed.';

export interface ParentCloseDeps {
  github: Pick<FactoryGithubPort, 'getIssue' | 'commentOnIssue' | 'closeIssue'>;
  /** Record the run's triage with the marker. */
  recordTriage(runId: string, triage: FactoryTriage): Promise<void>;
  activities: Pick<ServerActivities, 'recordServerActivity'>;
  now?: () => string;
}

/** The issues a run handed its issue's work to. */
const partsOf = (triage: FactoryTriage): number[] => [
  ...new Set([...(triage.splitInto ?? []), ...(triage.existing ?? [])]),
];

/** Whether the issue is closed on GitHub; null when it cannot be read now. */
async function isClosed(
  deps: ParentCloseDeps,
  reader: FactoryRepoReader,
  issue: number,
): Promise<boolean | null> {
  const read = await deps.github.getIssue(reader, issue);
  if (read.isErr()) return null;
  return read.value.state === 'closed';
}

/** Whether every part is closed; false at the first open or unreadable one. */
async function allClosed(
  deps: ParentCloseDeps,
  reader: FactoryRepoReader,
  parts: readonly number[],
): Promise<boolean> {
  for (const part of parts) {
    if ((await isClosed(deps, reader, part)) !== true) return false;
  }
  return true;
}

/** Comment on the parent and close it; whether it is closed now. */
async function closeParent(
  deps: ParentCloseDeps,
  reader: FactoryRepoReader,
  issue: number,
  parts: readonly number[],
): Promise<boolean> {
  if (!deps.github.closeIssue) return false;
  const body = [PARENT_CLOSED_LINE, parts.map((n) => `- #${n}`).join('\n')].join('\n\n');
  const commented = await deps.github.commentOnIssue(reader, issue, body);
  if (commented.isErr()) {
    log.warn('Issue factory could not comment before closing the issue', {
      namespace: 'factory',
      issue,
      error: commented.error.message,
    });
  }
  const closed = await deps.github.closeIssue(reader, issue);
  if (closed.isErr()) {
    log.warn('Issue factory could not close an issue whose parts are closed', {
      namespace: 'factory',
      issue,
      error: closed.error.message,
    });
  }
  return closed.isOk();
}

/** The latest run of each issue that handed its work away and is not marked yet. */
export function parentsToCheck(all: readonly FactoryRunView[]): FactoryRunView[] {
  // `all` is newest first: the first run seen for an issue is its latest.
  const seen = new Set<number>();
  const found: FactoryRunView[] = [];
  for (const run of all) {
    if (run.issueNumber === null || seen.has(run.issueNumber)) continue;
    seen.add(run.issueNumber);
    if (delegatedWork(run) && !run.triage?.partsClosedAt) found.push(run);
  }
  return found;
}

/**
 * Close every issue of `all` whose parts are all closed (see the module
 * comment). An issue or part that cannot be read, or a close GitHub refuses,
 * is looked at again on the next pass.
 */
export async function closeFinishedParents(
  deps: ParentCloseDeps,
  reader: FactoryRepoReader,
  all: readonly FactoryRunView[],
): Promise<void> {
  for (const run of parentsToCheck(all)) {
    const issue = run.issueNumber!;
    const triage = run.triage!;
    const parts = partsOf(triage);
    if (!(await allClosed(deps, reader, parts))) continue;
    const parentClosed = await isClosed(deps, reader, issue);
    if (parentClosed === null) continue;
    if (!parentClosed) {
      if (!(await closeParent(deps, reader, issue, parts))) continue;
      await deps.activities.recordServerActivity(
        {
          kind: 'factory.close_parent',
          userId: reader.ownerId,
          projectId: reader.projectId,
          title: `Closed issue #${issue}: every issue that carried its work is closed`,
          input: { issueNumber: issue, parts },
          origin: 'system',
        },
        { ok: true, effects: [] },
      );
      log.info('Issue factory closed an issue whose parts are closed', {
        namespace: 'factory',
        runId: run.id,
        issue,
        parts,
      });
    }
    await deps.recordTriage(run.id, {
      ...triage,
      partsClosedAt: deps.now?.() ?? new Date().toISOString(),
    });
  }
}
