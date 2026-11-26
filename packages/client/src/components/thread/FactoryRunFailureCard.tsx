import type { TFunction } from 'i18next';
/**
 * The error of a factory thread's pipeline, as a card in the thread at the
 * time it happened: where the run stopped, why, and the member's controls. The footer
 * indicator shows the same failure, but only when its popover is opened; this
 * card makes it visible without looking for it. It goes away once the run is
 * retried (the failure is cleared) or moves on.
 */
import { CircleX, MessageSquareText } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { FactoryRunControls } from '@/components/thread/FactoryRunControls';
import { useFactoryRunForThread } from '@/data/factory/hooks';
import {
  factoryRunFailedStep,
  factoryRunReasonDetail,
  factoryRunReasonText,
  isFactoryRunFailed,
  isFactoryRunNoChange,
  isFactoryRunNotPushed,
  isFactoryRunUnsavedWork,
  factoryRunBanner,
} from '@/lib/factory-run-labels';
import { useThreadById } from '@/lib/thread-selectors';
import { isFactoryThread } from '@/lib/thread-variant';

export function FactoryRunFailureCard({
  threadId,
  agentRunning,
}: {
  threadId?: string;
  /** The agent is working on the thread again (a take-over): its own status shows. */
  agentRunning: boolean;
}) {
  const thread = useThreadById(threadId);
  if (agentRunning || !threadId || !thread?.projectId || !isFactoryThread(thread)) return null;
  return <FactoryRunFailure projectId={thread.projectId} threadId={threadId} />;
}

/** The failure (or "no change") card of the run that started `threadId`, while it shows one. */
type NoChangeRun = Parameters<typeof isFactoryRunNotPushed>[0] & { issueNumber: number | null };

/** The no-change card's title: the agent did not push, or made no change. */
function noChangeTitle(t: TFunction, run: NoChangeRun): string {
  return isFactoryRunNotPushed(run)
    ? t('factory.noChange.notPushedTitle', 'The agent did not push its commits')
    : t('factory.noChange.title', 'The agent made no change');
}

/**
 * What the card says of a run that left no pull request without an error:
 * committed but never pushed, unsaved work in its checkout, or no change.
 */
function noChangeBody(t: TFunction, run: NoChangeRun): string {
  const issue = { issue: run.issueNumber };
  if (isFactoryRunNotPushed(run)) {
    return t(
      'factory.noChange.notPushedBody',
      'It committed in its checkout but ended its turn before pushing, so there is no pull request. The checkout was kept (its path is on issue #{{issue}}). Follow up on this thread to have it push and open the pull request, or retry the run.',
      issue,
    );
  }
  if (isFactoryRunUnsavedWork(run)) {
    return t(
      'factory.noChange.unsavedBody',
      'It opened no pull request and committed nothing, but left unsaved work in its checkout, which was kept (its path is on issue #{{issue}}). Follow up on this thread to have it commit and open the pull request, or retry the run.',
      issue,
    );
  }
  return t(
    'factory.noChange.body',
    'It opened no pull request and committed nothing. Its explanation is posted on issue #{{issue}}, now marked for triage: close the issue, or retry the run.',
    issue,
  );
}

export function FactoryRunFailure({
  projectId,
  threadId,
}: {
  projectId: string;
  threadId: string;
}) {
  const { t } = useTranslation();
  const run = useFactoryRunForThread(projectId, threadId);
  if (!run || !(isFactoryRunFailed(run) || isFactoryRunNoChange(run))) return null;
  const step = factoryRunFailedStep(run);
  // A merge gate's hold (high risk, no review, …) reads as what it is, with why.
  const shortReason = run.failureReason ? factoryRunReasonText(t, run.failureReason) : null;
  const heldReason = shortReason !== run.failureReason ? shortReason : null;
  const detail = factoryRunReasonDetail(t, run);
  const controls = (
    <div className="flex items-center justify-end gap-1">
      <FactoryRunControls
        projectId={projectId}
        run={run}
        testId={(button) => `factory-run-failure-${button}`}
      />
    </div>
  );

  // Not an error: the agent found nothing to change and said why on the issue
  // (the run ended), committed nothing but left work in its checkout, or
  // committed but never pushed.
  const notPushed = isFactoryRunNotPushed(run);
  if (isFactoryRunNoChange(run) || isFactoryRunUnsavedWork(run) || notPushed) {
    return (
      <div
        className="bg-card space-y-2 rounded-lg border px-3 py-2 text-xs"
        data-testid="factory-run-no-change-card"
      >
        <div className="flex items-center gap-2">
          <MessageSquareText className="text-muted-foreground icon-sm shrink-0" />
          <span className="font-medium">{noChangeTitle(t, run)}</span>
          <span className="text-muted-foreground ml-auto">{factoryRunBanner(t, run)}</span>
        </div>
        <p className="text-foreground">{noChangeBody(t, run)}</p>
        {controls}
      </div>
    );
  }

  return (
    <div
      className="border-destructive/40 bg-destructive/5 space-y-2 rounded-lg border px-3 py-2 text-xs"
      data-testid="factory-run-failure-card"
    >
      <div className="flex items-center gap-2">
        <CircleX className="text-destructive icon-sm shrink-0" />
        <span className="text-destructive font-medium">
          {heldReason ??
            (step
              ? t('factory.failure.titleAtStep', 'The factory pipeline stopped at {{step}}', {
                  step,
                })
              : t('factory.failure.title', 'The factory pipeline stopped on an error'))}
        </span>
        <span className="text-muted-foreground ml-auto">{factoryRunBanner(t, run)}</span>
      </div>
      {detail && (
        <p
          className="text-foreground break-words whitespace-pre-wrap"
          data-testid="factory-run-failure-detail"
        >
          {detail}
        </p>
      )}
      {controls}
    </div>
  );
}
