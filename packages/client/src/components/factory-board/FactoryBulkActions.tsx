/**
 * Several factory runs picked on the board (each card's checkbox) and the
 * actions they share: retry the ones a retry is offered for, stop the ones
 * that have not ended (after a confirmation). Each run is asked on its own,
 * with the same per-run checks as its card's menu; the server decides.
 */
import type { DomainError } from '@funny/shared/errors';
import { RotateCcw, Square, X } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ConfirmDialog } from '@/components/ConfirmDialog';
import { canRetryFactoryRun, canStopFactoryRun } from '@/components/thread/FactoryRunControls';
import { Button } from '@/components/ui/button';
import { controlFactoryRun } from '@/data/factory/actions';
import type { FactoryQueueRun } from '@/lib/api/factory';
import { metric } from '@/lib/telemetry';
import { toastError } from '@/lib/toast-error';

type BulkAction = 'retry' | 'stop';

/** The selected runs a bulk action applies to. */
export function runsForBulkAction(
  runs: readonly FactoryQueueRun[],
  action: BulkAction,
): FactoryQueueRun[] {
  return runs.filter(action === 'retry' ? canRetryFactoryRun : canStopFactoryRun);
}

/** The board's selection: run ids, kept to the runs still listed. */
export function useFactoryRunSelection(runs: readonly FactoryQueueRun[] | undefined) {
  const [ids, setIds] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = useCallback((runId: string) => {
    setIds((current) => {
      const next = new Set(current);
      if (!next.delete(runId)) next.add(runId);
      return next;
    });
  }, []);
  const clear = useCallback(() => setIds(new Set()), []);
  const selectedRuns = useMemo(
    () => (ids.size === 0 ? [] : (runs ?? []).filter((run) => ids.has(run.id))),
    [ids, runs],
  );
  const selectedIds = useMemo(() => new Set(selectedRuns.map((run) => run.id)), [selectedRuns]);
  return { selectedIds, selectedRuns, toggle, clear };
}

async function runBulk(action: BulkAction, runs: readonly FactoryQueueRun[]): Promise<void> {
  const results = await Promise.all(
    runs.map((run) => controlFactoryRun(action, run.projectId, run.id)),
  );
  const errors = results.flatMap((result): DomainError[] => (result.isErr() ? [result.error] : []));
  metric('factory.bulk_action', runs.length, {
    attributes: { action, failed: String(errors.length) },
  });
  // One toast for the batch, not one per run.
  if (errors[0]) toastError(errors[0], 'factory');
}

export function FactoryBulkActions({
  runs,
  onClear,
}: {
  runs: readonly FactoryQueueRun[];
  onClear: () => void;
}) {
  const { t } = useTranslation();
  const [confirmingStop, setConfirmingStop] = useState(false);
  if (runs.length === 0) return null;
  const toRetry = runsForBulkAction(runs, 'retry');
  const toStop = runsForBulkAction(runs, 'stop');
  const apply = (action: BulkAction, targets: FactoryQueueRun[]) => {
    void runBulk(action, targets);
    onClear();
  };

  return (
    <div
      className="bg-popover text-popover-foreground absolute bottom-4 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1 rounded-lg border px-2 py-1.5 shadow-lg"
      data-testid="factory-bulk-actions"
    >
      <span className="px-1.5 text-sm" data-testid="factory-bulk-count">
        {t('factoryBoard.selection.count', '{{count}} selected', { count: runs.length })}
      </span>
      <div className="bg-border mx-1 h-4 w-px" />
      <Button
        size="xs"
        variant="ghost"
        disabled={toRetry.length === 0}
        data-testid="factory-bulk-retry"
        onClick={() => apply('retry', toRetry)}
      >
        <RotateCcw className="icon-sm" />
        {t('factoryBoard.selection.retry', 'Retry ({{count}})', { count: toRetry.length })}
      </Button>
      <Button
        size="xs"
        variant="ghost-destructive"
        disabled={toStop.length === 0}
        data-testid="factory-bulk-stop"
        onClick={() => setConfirmingStop(true)}
      >
        <Square className="icon-sm" />
        {t('factoryBoard.selection.stop', 'Stop ({{count}})', { count: toStop.length })}
      </Button>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label={t('factoryBoard.selection.clear', 'Clear selection')}
        data-testid="factory-bulk-clear"
        onClick={onClear}
      >
        <X className="icon-sm" />
      </Button>
      <ConfirmDialog
        open={confirmingStop}
        onOpenChange={setConfirmingStop}
        title={t('factoryBoard.selection.stopTitle', 'Stop {{count}} runs?', {
          count: toStop.length,
        })}
        description={t(
          'factoryBoard.selection.stopDesc',
          'This stops the selected runs that have not ended and their agent threads.',
        )}
        variant="destructive"
        confirmLabel={t('factory.stop', 'Stop')}
        cancelLabel={t('common.cancel', 'Cancel')}
        onCancel={() => setConfirmingStop(false)}
        onConfirm={() => {
          setConfirmingStop(false);
          apply('stop', toStop);
        }}
      />
    </div>
  );
}
