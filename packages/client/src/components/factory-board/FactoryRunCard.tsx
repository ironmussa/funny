/**
 * A run on the factory board (openspec factory-pipeline-board): its issue and
 * project, the flow strip, the gate chips and why it waits. Opening it opens
 * the run's detail panel (openspec factory-run-detail). Not draggable: only the
 * server moves a run.
 */
import { implementingThreadOf } from '@funny/shared/contracts/factory';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { FactoryRunControls } from '@/components/thread/FactoryRunControls';
import type { FactoryQueueRun } from '@/lib/api/factory';
import { useThreadById } from '@/lib/thread-selectors';
import { timeAgo } from '@/lib/thread-utils';

import { factoryRunActivityAt } from './board-columns';
import { FactoryRunGateChips } from './FactoryRunGateChips';
import { FactoryRunProgress } from './FactoryRunProgress';
import { factoryRunWaitingText } from './run-waiting';

/** The issue's page, when the run's pull request tells the repository. */
function factoryIssueUrl(run: Pick<FactoryQueueRun, 'prUrl' | 'issueNumber'>): string | null {
  const repo = run.prUrl?.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/\d+/)?.[1];
  return repo ? `https://github.com/${repo}/issues/${run.issueNumber}` : null;
}

/** The thread a card opens: the implementing one, else the run's latest. */
export function factoryRunCardThread(
  run: Pick<FactoryQueueRun, 'threadIds' | 'stepOptions'>,
): string | undefined {
  return implementingThreadOf(run) ?? run.threadIds.at(-1);
}

interface Props {
  run: FactoryQueueRun;
  projectName: string | undefined;
  now: number;
  /** Opens the run's detail panel. */
  onSelect: (run: FactoryQueueRun) => void;
}

export const FactoryRunCard = memo(function FactoryRunCard({
  run,
  projectName,
  now,
  onSelect,
}: Props) {
  const { t } = useTranslation();
  const threadId = factoryRunCardThread(run);
  const thread = useThreadById(threadId);
  const title =
    thread?.title || t('factoryView.issueTitle', 'Issue #{{number}}', { number: run.issueNumber });
  const waiting = factoryRunWaitingText(t, run);
  const issueUrl = factoryIssueUrl(run);

  return (
    <div
      className="bg-card border-border/60 flex flex-col gap-1.5 rounded-md border p-2.5"
      draggable={false}
      data-testid={`factory-board-card-${run.id}`}
    >
      <button
        type="button"
        className="text-foreground line-clamp-2 text-left text-sm"
        onClick={() => onSelect(run)}
        data-testid={`factory-board-open-${run.id}`}
      >
        {title}
      </button>
      <div className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs">
        {projectName && <span className="truncate">{projectName}</span>}
        {issueUrl ? (
          <a
            href={issueUrl}
            target="_blank"
            rel="noreferrer"
            className="hover:text-foreground shrink-0 underline-offset-2 hover:underline"
            data-testid={`factory-board-issue-${run.id}`}
          >
            #{run.issueNumber}
          </a>
        ) : (
          <span className="shrink-0">#{run.issueNumber}</span>
        )}
        <span className="ml-auto shrink-0">{timeAgo(factoryRunActivityAt(run), t, now)}</span>
      </div>
      <FactoryRunProgress run={run} />
      <FactoryRunGateChips run={run} />
      {waiting && (
        <p
          className="text-muted-foreground line-clamp-2 text-xs"
          title={waiting}
          data-testid={`factory-board-waiting-${run.id}`}
        >
          {waiting}
        </p>
      )}
      <div className="flex items-center justify-end gap-1 empty:hidden">
        <FactoryRunControls
          projectId={run.projectId}
          run={run}
          testId={(button) => `factory-board-${button}-${run.id}`}
        />
      </div>
    </div>
  );
});
