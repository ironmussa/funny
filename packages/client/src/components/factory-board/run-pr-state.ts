/**
 * The state of a factory run's pull request on its board card. A merged run's
 * PR is merged; a run still in flight keeps its PR open. A run that ended
 * without merging (stopped, failed, replaced) may have had its PR closed, by
 * the factory or on GitHub, so the card asks GitHub once instead of guessing.
 */
import type { PRDetail } from '@funny/shared';
import { useEffect } from 'react';

import { pullRequestNumber } from '@/components/thread/FactoryRunControls';
import { usePRDetail } from '@/data/pull-requests/hooks';
import { fetchPRDetail } from '@/data/pull-requests/queries';
import type { FactoryQueueRun } from '@/lib/api/factory';
import { ENDED_FACTORY_STATES } from '@/lib/factory-run-labels';
import type { PRState } from '@/lib/git-icons';

type RunPrFields = Pick<FactoryQueueRun, 'state' | 'prUrl'>;

/** Whether only GitHub can say if the run's pull request is still open. */
export function factoryRunPrStateUnknown(run: RunPrFields): boolean {
  return Boolean(run.prUrl) && run.state !== 'merged' && ENDED_FACTORY_STATES.has(run.state);
}

/** The PR's state from the run, and from GitHub's answer when the run cannot tell. */
export function factoryRunPrState(
  run: RunPrFields,
  detail: Pick<PRDetail, 'state' | 'merged'> | undefined,
): PRState {
  if (run.state === 'merged' || detail?.merged) return 'MERGED';
  if (detail?.state === 'closed') return 'CLOSED';
  return 'OPEN';
}

/** {@link factoryRunPrState}, reading GitHub (cached, once) for a run that ended unmerged. */
export function useFactoryRunPrState(
  run: RunPrFields & Pick<FactoryQueueRun, 'projectId'>,
): PRState {
  const prNumber = run.prUrl ? (pullRequestNumber(run.prUrl) ?? undefined) : undefined;
  const lookup = factoryRunPrStateUnknown(run) ? prNumber : undefined;
  useEffect(() => {
    if (lookup) void fetchPRDetail(run.projectId, lookup);
  }, [run.projectId, lookup]);
  const { detail } = usePRDetail(run.projectId, lookup);
  return factoryRunPrState(run, detail);
}
