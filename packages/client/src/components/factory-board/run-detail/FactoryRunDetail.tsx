/**
 * A factory run's detail panel (openspec factory-run-detail): the run's story
 * in pipeline order, every agent step linked to its thread. A pure view of one
 * listed run, so it follows the run as it changes.
 */
import { useTranslation } from 'react-i18next';

import { FactoryRunControls } from '@/components/thread/FactoryRunControls';
import { RegressionProofDetails } from '@/components/thread/FactoryRunProofCard';
import { LabelBadge } from '@/components/ui/label-badge';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import type { FactoryQueueRun } from '@/lib/api/factory';
import { factoryRunStateLabel } from '@/lib/factory-run-labels';
import { useThreadById } from '@/lib/thread-selectors';

import { factoryRunCardThread } from '../FactoryRunCard';
import { FactoryRunProgress } from '../FactoryRunProgress';
import { factoryRunWaitingText } from '../run-waiting';
import { RunTimeline } from './RunTimeline';
import {
  DetailSection,
  RunReviews,
  RunRiskCi,
  RunThreads,
  RunTriage,
  ThreadLink,
} from './sections';

function RunHeader({
  run,
  projectName,
}: {
  run: FactoryQueueRun;
  projectName: string | undefined;
}) {
  const { t } = useTranslation();
  const threadId = factoryRunCardThread(run);
  const thread = useThreadById(threadId);
  return (
    <SheetHeader className="pr-8">
      <SheetTitle data-testid="factory-run-detail-title">
        {thread?.title ||
          t('factoryView.issueTitle', 'Issue #{{number}}', { number: run.issueNumber })}
      </SheetTitle>
      <SheetDescription asChild>
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          {projectName && <span>{projectName}</span>}
          <span>#{run.issueNumber}</span>
          <LabelBadge tone="info" data-testid="factory-run-detail-state">
            {factoryRunStateLabel(t, run.state)}
          </LabelBadge>
        </div>
      </SheetDescription>
      <div className="flex flex-wrap items-center gap-1">
        <ThreadLink
          projectId={run.projectId}
          threadId={threadId}
          label={t('factoryRunDetail.openThread', 'Open thread')}
          testId="factory-run-detail-open-thread"
        />
        <FactoryRunControls
          projectId={run.projectId}
          run={run}
          testId={(button) => `factory-run-detail-${button}`}
        />
      </div>
    </SheetHeader>
  );
}

function RunFlow({ run }: { run: FactoryQueueRun }) {
  const { t } = useTranslation();
  if (run.flowSteps.length === 0) return null;
  const source =
    run.flowSource === 'repository'
      ? t('factory.flowSource.repository', 'repository')
      : t('factory.flowSource.builtIn', 'built-in');
  return (
    <DetailSection id="flow" title={t('factoryRunDetail.flow', 'Flow')}>
      <p>
        {run.flowName ?? t('factory.flowUnknown', 'flow')}
        {run.flowSource && ` · ${source}`}
        {run.flowCommit && <span className="font-mono"> · {run.flowCommit.slice(0, 7)}</span>}
      </p>
      <FactoryRunProgress run={run} />
    </DetailSection>
  );
}

function RunOutcome({ run }: { run: FactoryQueueRun }) {
  const { t } = useTranslation();
  const text = factoryRunWaitingText(t, run);
  if (!text) return null;
  return (
    <DetailSection id="outcome" title={t('factoryRunDetail.outcome', 'Why it stopped')}>
      <p className="text-foreground">{text}</p>
    </DetailSection>
  );
}

function FactoryRunDetailBody({
  run,
  projectName,
}: {
  run: FactoryQueueRun;
  projectName: string | undefined;
}) {
  return (
    <div className="flex flex-col gap-4">
      <RunHeader run={run} projectName={projectName} />
      <RunOutcome run={run} />
      <RunFlow run={run} />
      <RunTimeline run={run} />
      <RunTriage run={run} />
      {run.regressionProof && <RegressionProofDetails proof={run.regressionProof} />}
      <RunReviews run={run} />
      <RunRiskCi run={run} />
      <RunThreads run={run} />
    </div>
  );
}

export function FactoryRunDetail({
  run,
  projectName,
  onClose,
}: {
  run: FactoryQueueRun | undefined;
  projectName: string | undefined;
  onClose: () => void;
}) {
  return (
    <Sheet open={run !== undefined} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        className="w-full overflow-y-auto sm:max-w-xl"
        data-testid="factory-run-detail"
      >
        {run && <FactoryRunDetailBody run={run} projectName={projectName} />}
      </SheetContent>
    </Sheet>
  );
}
