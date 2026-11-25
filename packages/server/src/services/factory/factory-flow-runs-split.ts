/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: app-service
 * @domain layer: application
 *
 * A member splits a run parked because triage found its issue too large: the
 * parts triage proposed (stored on the run) are opened as issues, queued in
 * the factory and listed on the parent, which loses the label; the run ends
 * `done`. No agent runs. Parts an earlier attempt opened are not opened again.
 */
import type { FactoryTriage } from '@funny/shared/contracts/factory';
import { err, ok, type Result } from 'neverthrow';

import { scopeOf, splitDepsFor } from './factory-flow-runs-provider.js';
import type { FactoryFlowRunsDeps, FactoryRunJob } from './factory-flow-runs-support.js';
import type { FactoryRepoReader } from './factory-github.js';
import type { FactoryRunView } from './factory-runs.js';
import {
  announceSplit,
  isSplitPart,
  openSplitParts,
  type FactorySplitDeps,
  type SplitWork,
} from './factory-triage.js';

/** The stored parts of a run parked as too large, or why it cannot be split. */
function parkedSplitParts(
  run: FactoryRunView,
): Result<{ triage: FactoryTriage; parts: string[] }, string> {
  const triage = run.triage;
  if (run.state !== 'needs_info' || triage?.decision !== 'too_big') {
    return err('Only a run parked because its issue is too large can be split.');
  }
  const parts = triage.items ?? [];
  return parts.length > 0 ? ok({ triage, parts }) : err('Triage proposed no parts for this issue.');
}

interface SplitTarget {
  split: FactorySplitDeps;
  reader: FactoryRepoReader;
  parent: SplitWork['parent'];
}

export function createParkedSplit(deps: FactoryFlowRunsDeps) {
  /** Runs a member is splitting now: a second click must not open the parts twice. */
  const splitting = new Set<string>();

  /** What splitting the run's issue needs: the GitHub writes, and the parent as GitHub has it. */
  async function splitTarget(job: FactoryRunJob): Promise<Result<SplitTarget, string>> {
    const scope = scopeOf(job);
    const split = splitDepsFor(deps, job, scope);
    if (!split || scope.issueNumber === null) return err('This factory cannot open issues.');
    const reader = { repo: scope.repo, ownerId: scope.userId, projectId: scope.projectId };
    const text = await deps.github.issueText(reader, scope.issueNumber);
    const issue = text.isOk() ? text.value : null;
    if (isSplitPart(issue)) {
      return err('The issue is itself a part of a split; it is not split again.');
    }
    const parent = {
      number: scope.issueNumber,
      title: issue?.title ?? scope.issueTitle,
      body: issue?.body ?? null,
    };
    return ok({ split, reader, parent });
  }

  /** End the split run `done` with the issues opened; refused when the run moved meanwhile. */
  async function closeSplitRun(
    runId: string,
    triage: FactoryTriage,
    opened: number[],
  ): Promise<Result<void, string>> {
    const done = await deps.runs.markSplit(runId, { ...triage, splitInto: opened });
    if (done.isErr()) return err(done.error.message);
    if (done.value) return ok(undefined);
    const issues = opened.map((n) => `#${n}`).join(', ');
    return err(
      `The run changed while it was being split; issues ${issues} were opened but not queued.`,
    );
  }

  async function splitParkedRun(job: FactoryRunJob): Promise<Result<number[], string>> {
    const stored = parkedSplitParts(job.run);
    if (stored.isErr()) return err(stored.error);
    const target = await splitTarget(job);
    if (target.isErr()) return err(target.error);
    const { triage, parts } = stored.value;
    const { split, reader, parent } = target.value;
    const work: SplitWork = { runId: job.run.id, parent, parts, opened: triage.splitInto ?? [] };
    const opened = await openSplitParts(split, work, async (splitInto) => {
      await deps.runs.recordSplitProgress(job.run.id, { ...triage, splitInto });
    });
    if (opened.length === 0) return err('No part of the split could be opened on GitHub.');
    const closed = await closeSplitRun(job.run.id, triage, opened);
    if (closed.isErr()) return err(closed.error);
    const comment = async (body: string) => {
      const posted = await deps.github.commentOnIssue(reader, parent.number, body);
      return posted.isOk() ? ok(undefined) : err(posted.error.message);
    };
    await announceSplit(split, comment, work, opened);
    return ok(opened);
  }

  return {
    /** Split the run once at a time; the issues opened, or why nothing was. */
    async split(job: FactoryRunJob): Promise<Result<number[], string>> {
      const runId = job.run.id;
      if (splitting.has(runId)) return err('The run is already being worked on.');
      splitting.add(runId);
      try {
        return await splitParkedRun(job);
      } finally {
        splitting.delete(runId);
      }
    },
  };
}
