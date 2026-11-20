/**
 * The error of a factory thread's pipeline, as a card at the end of the
 * thread: where the run stopped, why, and the member's controls. The footer
 * indicator shows the same failure, but only when its popover is opened; this
 * card makes it visible without looking for it. It goes away once the run is
 * retried (the failure is cleared) or moves on.
 */
import { CircleX } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { FactoryRunControls } from '@/components/thread/FactoryRunControls';
import { useFactoryRunForThread } from '@/data/factory/hooks';
import { factoryRunFailedStep, isFactoryRunFailed } from '@/lib/factory-run-labels';
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
  if (!run || !isFactoryRunFailed(run)) return null;
  const step = factoryRunFailedStep(run);

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
      <div className="flex items-center justify-end gap-1">
        <FactoryRunControls
          projectId={projectId}
          run={run}
          testId={(button) => `factory-run-failure-${button}`}
        />
      </div>
    </div>
  );
}
