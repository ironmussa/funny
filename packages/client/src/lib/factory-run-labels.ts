/**
 * How a factory run reads in the UI (change issue-factory, factory-manual-queue):
 * the state's label and badge variant, and why a queued issue waits. Shared by
 * the project's factory runs list and the Issues tab.
 */
import type { TFunction } from 'i18next';

import type { FactoryRun, FactoryWaitReason } from '@/lib/api/factory';

/** States a run no longer moves out of by itself. */
export const ENDED_FACTORY_STATES: ReadonlySet<FactoryRun['state']> = new Set([
  'merged',
  'no_change',
  'failed',
  'stopped',
]);

export function factoryRunStateLabel(t: TFunction, state: FactoryRun['state']): string {
  const labels: Record<FactoryRun['state'], string> = {
    requested: t('factory.state.requested', 'In queue'),
    queued: t('factory.state.queued', 'Queued'),
    triaging: t('factory.state.triaging', 'Triaging'),
    needs_info: t('factory.state.needsInfo', 'Needs info'),
    working: t('factory.state.working', 'Working'),
    pr_open: t('factory.state.prOpen', 'PR open'),
    waiting_ci: t('factory.state.waitingCi', 'Waiting for CI'),
    fixing: t('factory.state.fixing', 'Fixing CI'),
    reviewing: t('factory.state.reviewing', 'In review'),
    merging: t('factory.state.merging', 'In the merge lane'),
    waiting_human: t('factory.state.waitingHuman', 'Waiting for you'),
    merged: t('factory.state.merged', 'Merged'),
    no_change: t('factory.state.noChange', 'No change needed'),
    failed: t('factory.state.failed', 'Failed'),
    stopped: t('factory.state.stopped', 'Stopped'),
  };
  return labels[state];
}

export function factoryRunStateVariant(state: FactoryRun['state']) {
  if (state === 'waiting_human') return 'default' as const;
  if (state === 'failed') return 'destructive' as const;
  return ENDED_FACTORY_STATES.has(state) ? ('outline' as const) : ('secondary' as const);
}

const issues = (numbers: number[]) => numbers.map((n) => `#${n}`).join(', ');

/** Why a queued issue is not admitted yet. */
export function factoryWaitReasonText(t: TFunction, reason: FactoryWaitReason): string {
  const blockers = issues(reason.blockers);
  switch (reason.kind) {
    case 'blocker-not-sent':
      return t('factory.wait.notSent', 'Blocked by {{blockers}}, which is not in the factory', {
        blockers,
      });
    case 'blocker-in-progress':
      return t('factory.wait.inProgress', 'Waiting for {{blockers}} to finish', { blockers });
    case 'blocker-waiting-merge':
      return t('factory.wait.waitingMerge', 'Waiting for the pull request of {{blockers}}', {
        blockers,
      });
    case 'blocker-failed':
      return t('factory.wait.failed', 'Blocked by {{blockers}}, whose run failed or was stopped', {
        blockers,
      });
    case 'blocker-other-repo':
      return t('factory.wait.otherRepo', 'Blocked by {{blockers}} in another repository', {
        blockers,
      });
    case 'circular':
      return t('factory.wait.circular', 'Circular dependency with {{blockers}}', { blockers });
    case 'blockers-unreadable':
      return t('factory.wait.unreadable', 'Its blockers could not be read from GitHub');
    case 'paths-overlap':
      return t(
        'factory.wait.pathsOverlap',
        'Waiting for {{blockers}}: it works on the same files',
        { blockers },
      );
    case 'proof-not-configured':
      return t(
        'factory.wait.proofNotConfigured',
        'Regression proof not configured: its flow has no proof rules, so it would never merge',
      );
  }
}

export type FactoryStepStatus = 'done' | 'current' | 'failed' | 'pending';

/** States a flow is moving through a step in. */
const MOVING: ReadonlySet<FactoryRun['state']> = new Set([
  'queued',
  'triaging',
  'working',
  'pr_open',
  'waiting_ci',
  'fixing',
  'reviewing',
  'merging',
]);

/**
 * Whether the run's pipeline stopped on an error: it failed, or it waits for
 * the member after a failure (the flow's `on_failure` parked it).
 */
/**
 * The reason a run waits for the member with when the agent committed nothing
 * but left unsaved work in its checkout (kept, and named on the issue).
 */
const NO_CHANGE_REASON = 'no change';

/** The agent found nothing to change: the run ended, explained on the issue. Not a failure. */
export function isFactoryRunNoChange(run: Pick<FactoryRun, 'state'>): boolean {
  return run.state === 'no_change';
}

/** No commit and no pull request, but unsaved work in the run's checkout: a person looks. */
export function isFactoryRunUnsavedWork(run: Pick<FactoryRun, 'state' | 'failureReason'>): boolean {
  return run.state === 'waiting_human' && run.failureReason === NO_CHANGE_REASON;
}

export function isFactoryRunFailed(run: Pick<FactoryRun, 'state' | 'failureReason'>): boolean {
  return run.state === 'failed' || (run.state === 'waiting_human' && run.failureReason !== null);
}

/** The step the run failed at, when it failed at one. */
export function factoryRunFailedStep(
  run: Pick<FactoryRun, 'state' | 'currentStep' | 'flowSteps' | 'failureReason'>,
): string | null {
  return factoryRunSteps(run).find((step) => step.status === 'failed')?.name ?? null;
}

/**
 * Each step of the run's flow, with how far the run got: the steps before the
 * current one are done; the current one is in progress, or failed when the
 * run failed (or waits for the member after a failure) there. A run whose flow
 * ended without a current step (merged, or parked with its PR ready) has done
 * them all. Older runs recorded no steps: only the current one is known.
 */
export function factoryRunSteps(
  run: Pick<FactoryRun, 'state' | 'currentStep' | 'flowSteps' | 'failureReason'>,
): Array<{ name: string; status: FactoryStepStatus }> {
  const names = run.flowSteps.length > 0 ? run.flowSteps : run.currentStep ? [run.currentStep] : [];
  const at = run.currentStep ? names.indexOf(run.currentStep) : -1;
  const flowEnded = run.state === 'merged' || (run.state === 'waiting_human' && at === -1);
  const failedHere = isFactoryRunFailed(run);
  return names.map((name, index) => {
    if (flowEnded) return { name, status: 'done' };
    if (at === -1 || index > at) return { name, status: 'pending' };
    if (index < at) return { name, status: 'done' };
    if (failedHere) return { name, status: 'failed' };
    return { name, status: MOVING.has(run.state) ? 'current' : 'pending' };
  });
}

/** The factory view's groups (`/factory`), in the order it shows them. */
export type FactoryQueueSection = 'waiting' | 'active' | 'queue' | 'failed' | 'ended';

const SECTION_OF: Record<FactoryRun['state'], FactoryQueueSection> = {
  waiting_human: 'waiting',
  // Parked on its issue: it needs an answer there, from whoever wrote the issue.
  needs_info: 'waiting',
  queued: 'active',
  triaging: 'active',
  working: 'active',
  pr_open: 'active',
  waiting_ci: 'active',
  fixing: 'active',
  reviewing: 'active',
  merging: 'active',
  requested: 'queue',
  failed: 'failed',
  merged: 'ended',
  no_change: 'ended',
  stopped: 'ended',
};

const FACTORY_QUEUE_SECTIONS: readonly FactoryQueueSection[] = [
  'waiting',
  'active',
  'queue',
  'failed',
  'ended',
];

/** Runs per section; the queue in its order, the others newest first (the server's order). */
export function groupFactoryRuns<R extends FactoryRun>(
  runs: R[],
): Record<FactoryQueueSection, R[]> {
  const groups: Record<FactoryQueueSection, R[]> = {
    waiting: [],
    active: [],
    queue: [],
    failed: [],
    ended: [],
  };
  for (const run of runs) groups[SECTION_OF[run.state]].push(run);
  groups.queue.sort((a, b) => (a.queueOrder ?? 0) - (b.queueOrder ?? 0));
  return groups;
}

/** What the factory view filters its runs by. */
export interface FactoryRunFilter {
  /** Matches the issue number (a leading `#` is ignored), the project name or the current step. */
  search: string;
  caseSensitive: boolean;
  /** The states to keep; empty keeps every state. */
  states: ReadonlySet<string>;
  /** The projects to keep; empty keeps every project. */
  projectIds: ReadonlySet<string>;
  projectNameById: ReadonlyMap<string, string>;
  /** Hide the runs that finished without needing anyone (merged, no change, stopped). */
  activeOnly?: boolean;
}

/** Finished, and nobody has to look at them: what the Active filter hides. */
const SETTLED: ReadonlySet<FactoryRun['state']> = new Set(['merged', 'no_change', 'stopped']);

/** The runs the factory view shows, in its order (waiting, in progress, queue, failed, ended). */
export function filterFactoryRuns<R extends FactoryRun & { projectId: string }>(
  runs: R[],
  { search, caseSensitive, states, projectIds, projectNameById, activeOnly }: FactoryRunFilter,
): R[] {
  const fold = (text: string) => (caseSensitive ? text : text.toLowerCase());
  const needle = fold(search.trim().replace(/^#/, ''));
  const matchesSearch = (run: R) =>
    !needle ||
    String(run.issueNumber).includes(needle) ||
    fold(projectNameById.get(run.projectId) ?? '').includes(needle) ||
    fold(run.currentStep ?? '').includes(needle);
  const kept = runs.filter(
    (run) =>
      !(activeOnly && SETTLED.has(run.state)) &&
      (states.size === 0 || states.has(run.state)) &&
      (projectIds.size === 0 || projectIds.has(run.projectId)) &&
      matchesSearch(run),
  );
  const groups = groupFactoryRuns(kept);
  return FACTORY_QUEUE_SECTIONS.flatMap((section) => groups[section]);
}

/**
 * Why a parked or failed run stopped, as the server recorded it. The merge
 * gate's reasons (change factory-agent-roles) get their own wording; any other
 * reason is shown as it is.
 */
export function factoryRunReasonText(t: TFunction, reason: string): string {
  switch (reason) {
    case 'no review':
      return t('factory.reason.noReview', 'Not merged: this commit has no review');
    case 'review failed':
      return t('factory.reason.reviewFailed', 'Not merged: its review did not pass');
    case 'high risk':
      return t('factory.reason.highRisk', 'Not merged: high risk, it needs you');
    case 'branch history rewritten':
      return t('factory.reason.rewritten', 'Not merged: the branch was rewritten');
    case 'needs info':
      return t(
        'factory.reason.needsInfo',
        'Asked on the issue: it starts again when the issue changes',
      );
    case 'review gave no verdict':
      return t('factory.reason.noVerdict', 'The review gave no verdict');
    default:
      return reason;
  }
}

/**
 * Whether a review verdict lets the change go on: a pass, or a fail whose
 * findings are all below high (nothing that sends it back).
 */
export function factoryReviewPassed(review: FactoryRun['reviews'][number]): boolean {
  const blocking = review.findings.some(
    (finding) => finding.severity === 'critical' || finding.severity === 'high',
  );
  return review.verdict === 'pass' || (review.findings.length > 0 && !blocking);
}

/** The run's review as a short label: the verdict of its newest reviewed commit, or null. */
export function factoryRunReviewLabel(
  t: TFunction,
  run: Pick<FactoryRun, 'reviews'>,
): { text: string; passed: boolean } | null {
  const last = run.reviews.at(-1);
  if (!last) return null;
  const passed = factoryReviewPassed(last);
  return {
    passed,
    text: passed
      ? t('factory.review.passed', 'Review passed')
      : t('factory.review.failed', 'Review failed'),
  };
}

/**
 * The run's contract as a short label: that triage wrote one (its criteria in
 * `detail`), or that the run went on without one. Null before triage decided.
 */
export function factoryRunContractLabel(
  t: TFunction,
  run: Pick<FactoryRun, 'triage'>,
): { text: string; detail: string; missing: boolean } | null {
  const triage = run.triage;
  if (!triage || triage.superseded) return null;
  if (triage.decision === 'none') {
    return {
      missing: true,
      text: t('factory.contract.none', 'No contract'),
      detail: t(
        'factory.contract.noneDetail',
        'Triage gave no contract: the review judges against the issue',
      ),
    };
  }
  if (triage.decision !== 'ready' || !triage.contract) return null;
  return {
    missing: false,
    text: t('factory.contract.ready', 'Contract'),
    detail: triage.contract.acceptanceCriteria.join('\n'),
  };
}
