import type { RunTriageStatus } from '@funny/shared';
import { Check, RotateCcw, X } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { TriCheckbox } from '@/components/ui/tri-checkbox';
import { triageRuns } from '@/data/automations/actions';

import type { InboxSelection } from './use-inbox-selection';

/**
 * The start of the inbox toolbar, as GitHub's issue list header: the
 * select-all checkbox, then the status selector and filters; once some runs
 * are selected, how many and the status changes to apply to all of them at
 * once, in place of the filters.
 */
export function InboxSelectionControls({
  selection,
  children,
}: {
  selection: InboxSelection;
  /** The status selector and filters, shown while nothing is selected. */
  children: ReactNode;
}) {
  const { selected, visibleCount, toggleAll: onToggleAll, clear: onClear } = selection;
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const count = selected.length;
  const state =
    count === 0 ? 'unchecked' : count === visibleCount ? 'checked' : ('indeterminate' as const);

  const apply = (status: RunTriageStatus) => {
    setBusy(true);
    void triageRuns(selected, status).then(() => {
      setBusy(false);
      onClear();
    });
  };

  return (
    <div data-testid="inbox-selection-bar" className="flex flex-wrap items-center gap-2 text-xs">
      {visibleCount > 0 && (
        <TriCheckbox
          state={state}
          onToggle={onToggleAll}
          aria-label={t('automationInbox.selectAll')}
          data-testid="inbox-select-all"
        />
      )}
      {count === 0 ? (
        <>{children}</>
      ) : (
        <>
          <span className="font-medium" data-testid="inbox-selected-count">
            {t('automationInbox.selectedCount', { count })}
          </span>
          <div className="ml-auto flex items-center gap-1">
            <Button
              variant="ghost"
              size="xs"
              gap="snug"
              disabled={busy}
              data-testid="inbox-bulk-pending"
              onClick={() => apply('pending')}
            >
              <RotateCcw className="icon-sm" />
              {t('automationInbox.moveToPending')}
            </Button>
            <Button
              variant="ghost"
              size="xs"
              gap="snug"
              disabled={busy}
              data-testid="inbox-bulk-dismiss"
              onClick={() => apply('dismissed')}
            >
              <X className="icon-sm" />
              {t('automationInbox.dismiss')}
            </Button>
            <Button
              variant="outline"
              size="xs"
              gap="snug"
              disabled={busy}
              data-testid="inbox-bulk-review"
              onClick={() => apply('reviewed')}
            >
              <Check className="icon-sm" />
              {t('automationInbox.markReviewed')}
            </Button>
            <Button variant="ghost" size="xs" data-testid="inbox-clear-selection" onClick={onClear}>
              {t('automationInbox.clearSelection')}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
