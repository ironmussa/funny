/**
 * What a run waits on and what waits on it, for a board card and the run's
 * detail panel: "Stuck behind #434: <why>" in the warning color when its
 * blocker needs a person, and "Blocks #435, #437 · then #436" on the blocker.
 * Each issue opens its run.
 */
import { AlertTriangle, Link2 } from 'lucide-react';
import { Fragment } from 'react';
import { useTranslation } from 'react-i18next';

import type { FactoryQueueRun } from '@/lib/api/factory';
import { cn } from '@/lib/utils';

import {
  type FactoryRunDependencyLookup,
  isFactoryRunStuck,
  shortFactoryReason,
} from './run-dependencies';
import { factoryRunWaitingText } from './run-waiting';

interface Props {
  run: FactoryQueueRun;
  dependencies: FactoryRunDependencyLookup;
  /** Opens another run's detail panel. */
  onSelect: (run: FactoryQueueRun) => void;
  testIdPrefix: string;
}

function IssueLinks({
  issues,
  factoryId,
  dependencies,
  onSelect,
  testIdPrefix,
}: {
  issues: number[];
  factoryId: string;
  dependencies: FactoryRunDependencyLookup;
  onSelect: (run: FactoryQueueRun) => void;
  testIdPrefix: string;
}) {
  return (
    <>
      {issues.map((issue, index) => {
        const target = dependencies.runOf(factoryId, issue);
        return (
          <Fragment key={issue}>
            {index > 0 && ', '}
            {target ? (
              <button
                type="button"
                className="hover:text-foreground font-medium underline-offset-2 hover:underline"
                onClick={(event) => {
                  event.stopPropagation();
                  onSelect(target);
                }}
                data-testid={`${testIdPrefix}-issue-${issue}`}
              >
                #{issue}
              </button>
            ) : (
              <span className="font-medium">#{issue}</span>
            )}
          </Fragment>
        );
      })}
    </>
  );
}

export function FactoryRunDependencyNote({ run, dependencies, onSelect, testIdPrefix }: Props) {
  const { t } = useTranslation();
  const { blockedBy, blocks, blocksLater } = dependencies.of(run);
  const stuckBlockers = blockedBy.filter((blocker) => blocker.stuck);
  if (stuckBlockers.length === 0 && blocks.length === 0) return null;
  const links = { factoryId: run.factoryId, dependencies, onSelect, testIdPrefix };
  const firstStuck = stuckBlockers[0]?.run;
  const stuckWhy = firstStuck ? factoryRunWaitingText(t, firstStuck) : null;
  const holding = isFactoryRunStuck(run);

  return (
    <div className="flex flex-col gap-1 text-xs" data-testid={testIdPrefix}>
      {stuckBlockers.length > 0 && (
        <p
          className="text-status-warning flex items-start gap-1"
          data-testid={`${testIdPrefix}-stuck-behind`}
        >
          <AlertTriangle className="icon-xs mt-0.5 shrink-0" />
          <span className="min-w-0">
            {t('factoryBoard.deps.stuckBehind', 'Stuck behind')}{' '}
            <IssueLinks issues={stuckBlockers.map((blocker) => blocker.issue)} {...links} />
            {': '}
            {stuckWhy
              ? shortFactoryReason(stuckWhy)
              : t('factoryBoard.deps.needsPerson', 'it needs a person')}
          </span>
        </p>
      )}
      {blocks.length > 0 && (
        <p
          className={cn(
            'flex items-start gap-1',
            holding ? 'text-status-warning' : 'text-muted-foreground',
          )}
          data-testid={`${testIdPrefix}-blocks`}
        >
          <Link2 className="icon-xs mt-0.5 shrink-0" />
          <span className="min-w-0">
            {t('factoryBoard.deps.blocks', 'Blocks')} <IssueLinks issues={blocks} {...links} />
            {blocksLater.length > 0 && (
              <>
                {' · '}
                {t('factoryBoard.deps.then', 'then')} <IssueLinks issues={blocksLater} {...links} />
              </>
            )}
          </span>
        </p>
      )}
    </div>
  );
}
