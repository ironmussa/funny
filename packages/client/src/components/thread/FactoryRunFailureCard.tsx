/**
 * The error of a factory thread's pipeline, as a card at the end of the
 * thread: where the run stopped, why, and the member's controls. The footer
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
  isFactoryRunFailed,
  isFactoryRunNoChange,
  isFactoryRunUnsavedWork,
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
  return <RunFailure projectId={thread.projectId} threadId={threadId} />;
}

function RunFailure({ projectId, threadId }: { projectId: string; threadId: string }) {
  const { t } = useTranslation();
  const run = useFactoryRunForThread(projectId, threadId);
  if (!run || !(isFactoryRunFailed(run) || isFactoryRunNoChange(run))) return null;
  const step = factoryRunFailedStep(run);
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
  // (the run ended), or committed nothing but left work in its checkout.
  if (isFactoryRunNoChange(run) || isFactoryRunUnsavedWork(run)) {
    const unsaved = isFactoryRunUnsavedWork(run);
    return (
      <div
        className="bg-card space-y-2 rounded-lg border px-3 py-2 text-xs"
        data-testid="factory-run-no-change-card"
      >
        <div className="flex items-center gap-2">
          <MessageSquareText className="text-muted-foreground icon-sm shrink-0" />
          <span className="font-medium">
            {t('factory.noChange.title', 'The agent made no change')}
          </span>
          <span className="text-muted-foreground ml-auto">
            {t('factory.banner.title', 'Factory · #{{issue}}', { issue: run.issueNumber })}
          </span>
        </div>
        <p className="text-foreground">
          {unsaved
            ? t(
                'factory.noChange.unsavedBody',
                'It opened no pull request and committed nothing, but left unsaved work in its checkout, which was kept (its path is on issue #{{issue}}). Follow up on this thread to have it commit and open the pull request, or retry the run.',
                { issue: run.issueNumber },
              )
            : t(
                'factory.noChange.body',
                'It opened no pull request and committed nothing. Its explanation is posted on issue #{{issue}}, now marked for triage: close the issue, or retry the run.',
                { issue: run.issueNumber },
              )}
        </p>
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
          {step
            ? t('factory.failure.titleAtStep', 'The factory pipeline stopped at {{step}}', { step })
            : t('factory.failure.title', 'The factory pipeline stopped on an error')}
        </span>
        <span className="text-muted-foreground ml-auto">
          {t('factory.banner.title', 'Factory · #{{issue}}', { issue: run.issueNumber })}
        </span>
      </div>
      {run.failureReason && (
        <p className="text-foreground break-words whitespace-pre-wrap">{run.failureReason}</p>
      )}
      {controls}
    </div>
  );
}
