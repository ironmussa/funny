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
import { factoryRunStateLabel, factoryRunTitle, factoryRunRef } from '@/lib/factory-run-labels';
import { useThreadById } from '@/lib/thread-selectors';
import { cn } from '@/lib/utils';

import { factoryRunCardThread } from '../FactoryRunCard';
import { FactoryRunDependencyNote } from '../FactoryRunDependencyNote';
import { FactoryRunProgress } from '../FactoryRunProgress';
import {
  type FactoryRunDependencyLookup,
  isFactoryRunStuck,
  NO_FACTORY_RUN_DEPENDENCIES,
  plainFactoryReason,
} from '../run-dependencies';
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
        {factoryRunTitle(t, run, thread?.title)}
      </SheetTitle>
      <SheetDescription asChild>
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          {projectName && <span>{projectName}</span>}
          <span data-testid="factory-run-detail-ref">{factoryRunRef(t, run)}</span>
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

/** The input values a run without an issue was started with (change flow-triggers). */
function RunInputs({ run }: { run: FactoryQueueRun }) {
  const { t } = useTranslation();
  const entries = Object.entries(run.inputs);
  if (entries.length === 0) return null;
  return (
    <DetailSection id="inputs" title={t('factoryRunDetail.inputs', 'Inputs')}>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        {entries.map(([name, value]) => (
          <div key={name} className="contents" data-testid={`factory-run-detail-input-${name}`}>
            <dt className="text-muted-foreground font-mono">{name}</dt>
            <dd className="text-foreground break-words">{value}</dd>
          </div>
        ))}
      </dl>
    </DetailSection>
  );
}

interface DependencyProps {
  dependencies: FactoryRunDependencyLookup;
  onSelect: (run: FactoryQueueRun) => void;
}

function RunOutcome({ run, dependencies, onSelect }: { run: FactoryQueueRun } & DependencyProps) {
  const { t } = useTranslation();
  const waiting = factoryRunWaitingText(t, run);
  const text = waiting ? plainFactoryReason(waiting) : null;
  const deps = dependencies.of(run);
  if (!text && deps.blockedBy.length === 0 && deps.blocks.length === 0) return null;
  return (
    <DetailSection id="outcome" title={t('factoryRunDetail.outcome', 'Why it stopped')}>
      {text && (
        <p
          className={cn(
            'break-words whitespace-pre-wrap',
            isFactoryRunStuck(run) ? 'text-status-warning' : 'text-foreground',
          )}
        >
          {text}
        </p>
      )}
      <FactoryRunDependencyNote
        run={run}
        dependencies={dependencies}
        onSelect={onSelect}
        testIdPrefix="factory-run-detail-deps"
      />
    </DetailSection>
  );
}

function FactoryRunDetailBody({
  run,
  projectName,
  dependencies,
  onSelect,
}: {
  run: FactoryQueueRun;
  projectName: string | undefined;
} & DependencyProps) {
  return (
    <div className="flex flex-col gap-4">
      <RunHeader run={run} projectName={projectName} />
      <RunOutcome run={run} dependencies={dependencies} onSelect={onSelect} />
      <RunFlow run={run} />
      <RunInputs run={run} />
      <RunTimeline run={run} />
      {/* Triage, the proof and the reviews judge a change against an issue. */}
      {run.issueNumber !== null && (
        <>
          <RunTriage run={run} />
          {run.regressionProof && <RegressionProofDetails proof={run.regressionProof} />}
          <RunReviews run={run} />
        </>
      )}
      <RunRiskCi run={run} />
      <RunThreads run={run} />
    </div>
  );
}

/** Without the run list there is no other run to open. */
const ignoreSelect = () => {};

export function FactoryRunDetail({
  run,
  projectName,
  onClose,
  dependencies = NO_FACTORY_RUN_DEPENDENCIES,
  onSelect = ignoreSelect,
}: {
  run: FactoryQueueRun | undefined;
  projectName: string | undefined;
  onClose: () => void;
  /** How the listed runs hold each other back, and how to open another run. */
  dependencies?: FactoryRunDependencyLookup;
  onSelect?: (run: FactoryQueueRun) => void;
}) {
  return (
    <Sheet open={run !== undefined} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        className="w-full overflow-y-auto sm:max-w-xl"
        data-testid="factory-run-detail"
      >
        {run && (
          <FactoryRunDetailBody
            run={run}
            projectName={projectName}
            dependencies={dependencies}
            onSelect={onSelect}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}
