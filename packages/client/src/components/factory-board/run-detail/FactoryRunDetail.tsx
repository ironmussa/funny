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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { FactoryQueueRun } from '@/lib/api/factory';
import { factoryRunStateLabel, factoryRunTitle, factoryRunRef } from '@/lib/factory-run-labels';
import { useThreadById } from '@/lib/thread-selectors';
import { cn } from '@/lib/utils';

import { factoryRunCardThread } from '../FactoryRunCard';
import { FactoryRunDependencyNote } from '../FactoryRunDependencyNote';
import {
  type FactoryRunDependencyLookup,
  isFactoryRunStuck,
  NO_FACTORY_RUN_DEPENDENCIES,
  plainFactoryReason,
} from '../run-dependencies';
import { factoryRunWaitingText } from '../run-waiting';
import { RunSpec, hasFactoryRunSpec } from './RunSpec';
import { RunTimeline } from './RunTimeline';
import { DetailSection, RunReviews, RunRiskCi, RunThreads, RunTriage } from './sections';
import { factoryRunThreadLinks } from './thread-links';

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
    <SheetHeader>
      <SheetTitle className="mr-8" data-testid="factory-run-detail-title">
        {factoryRunTitle(t, run, thread?.title)}
      </SheetTitle>
      <SheetDescription asChild>
        <div className="mr-8 flex flex-wrap items-center gap-1.5 text-xs">
          {projectName && <span>{projectName}</span>}
          <span data-testid="factory-run-detail-ref">{factoryRunRef(t, run)}</span>
          <LabelBadge tone="info" data-testid="factory-run-detail-state">
            {factoryRunStateLabel(t, run.state)}
          </LabelBadge>
        </div>
      </SheetDescription>
      <div className="mr-8 flex flex-wrap items-center gap-1">
        <FactoryRunControls
          projectId={run.projectId}
          run={run}
          testId={(button) => `factory-run-detail-${button}`}
        />
      </div>
    </SheetHeader>
  );
}

/** Which flow the run follows, then its steps: how long each took, and the ones not reached. */
function RunFlow({ run }: { run: FactoryQueueRun }) {
  const { t } = useTranslation();
  const hasTimings = (run.stepTimings ?? []).length > 0;
  if (run.flowSteps.length === 0 && !hasTimings) return null;
  const source =
    run.flowSource === 'repository'
      ? t('factory.flowSource.repository', 'repository')
      : t('factory.flowSource.builtIn', 'built-in');
  return (
    <DetailSection id="flow" title={t('factoryRunDetail.flow', 'Flow')}>
      {run.flowSteps.length > 0 && (
        <p>
          {run.flowName ?? t('factory.flowUnknown', 'flow')}
          {run.flowSource && ` · ${source}`}
          {run.flowCommit && <span className="font-mono"> · {run.flowCommit.slice(0, 7)}</span>}
        </p>
      )}
      <RunTimeline run={run} />
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

type RunDetailTab = 'flow' | 'triage' | 'spec' | 'proof' | 'reviews' | 'risk' | 'threads';

/**
 * The tabs a run has, in pipeline order: one per section with something to
 * show. Triage, the proof and the reviews judge a change against an issue.
 */
function runDetailTabs(run: FactoryQueueRun): RunDetailTab[] {
  const judged = run.issueNumber !== null;
  const tabs: [RunDetailTab, boolean][] = [
    [
      'flow',
      run.flowSteps.length > 0 ||
        (run.stepTimings ?? []).length > 0 ||
        Object.keys(run.inputs).length > 0,
    ],
    ['triage', judged && Boolean(run.triage)],
    ['spec', judged && hasFactoryRunSpec(run)],
    ['proof', judged && Boolean(run.regressionProof)],
    ['reviews', judged && run.reviews.length > 0],
    ['risk', Boolean(run.risk || run.mergeApproval) || run.metrics.ciRounds > 0],
    ['threads', factoryRunThreadLinks(run).length > 0],
  ];
  return tabs.flatMap(([tab, shown]) => (shown ? [tab] : []));
}

function RunDetailTabContent({ run, tab }: { run: FactoryQueueRun; tab: RunDetailTab }) {
  switch (tab) {
    case 'flow':
      return (
        <>
          <RunFlow run={run} />
          <RunInputs run={run} />
        </>
      );
    case 'triage':
      return <RunTriage run={run} />;
    case 'spec':
      return <RunSpec run={run} />;
    case 'proof':
      return run.regressionProof ? <RegressionProofDetails proof={run.regressionProof} /> : null;
    case 'reviews':
      return <RunReviews run={run} />;
    case 'risk':
      return <RunRiskCi run={run} />;
    case 'threads':
      return <RunThreads run={run} />;
  }
}

/** One tab per section; the header and why the run stopped stay above them. */
function RunDetailTabs({ run }: { run: FactoryQueueRun }) {
  const { t } = useTranslation();
  const tabs = runDetailTabs(run);
  if (tabs.length === 0) return null;
  const labels: Record<RunDetailTab, string> = {
    flow: t('factoryRunDetail.flow', 'Flow'),
    triage: t('factoryRunDetail.triageTab', 'Triage'),
    spec: t('factoryRunDetail.specTab', 'Spec'),
    proof: t('factoryRunDetail.proofTab', 'Proof'),
    reviews: t('factoryRunDetail.reviewsTab', 'Reviews'),
    risk: t('factoryRunDetail.riskTab', 'Risk · CI'),
    threads: t('factoryRunDetail.threads', 'Agent threads'),
  };
  return (
    // Keyed by run: another run opens on its first tab.
    <Tabs key={run.id} defaultValue={tabs[0]} className="flex min-w-0 flex-col">
      <TabsList
        variant="underline"
        size="sm"
        className="w-full min-w-0 justify-start overflow-x-auto"
        data-testid="factory-run-detail-tabs"
      >
        {tabs.map((tab) => (
          <TabsTrigger
            key={tab}
            value={tab}
            variant="underline"
            size="sm"
            data-testid={`factory-run-detail-tab-${tab}`}
          >
            {labels[tab]}
          </TabsTrigger>
        ))}
      </TabsList>
      {tabs.map((tab) => (
        <TabsContent key={tab} value={tab} className="mt-3">
          <RunDetailTabContent run={run} tab={tab} />
        </TabsContent>
      ))}
    </Tabs>
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
      <RunDetailTabs run={run} />
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
