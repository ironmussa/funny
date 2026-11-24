import type { DeleteIssuesResult } from '@funny/shared/contracts/github-issues';
/**
 * The bar under the issues while some are selected: how many, clear the
 * selection, send the ones that can go to the factory, and delete them all on
 * GitHub after a confirmation.
 */
import type { TFunction } from 'i18next';
import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { ConfirmDialog } from '@/components/ConfirmDialog';
import { IssuesFactoryBar, type IssueFactory } from '@/components/issues/IssueFactoryControls';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { createClientLogger } from '@/lib/client-logger';
import { toastError } from '@/lib/toast-error';

const log = createClientLogger('issues-selection');

function reportDelete(t: TFunction, result: DeleteIssuesResult): void {
  if (result.deleted.length > 0) {
    toast.success(t('issues.deleted', { count: result.deleted.length }));
  }
  for (const failure of result.failed) {
    toast.error(
      t('issues.deleteFailed', {
        number: failure.issueNumber,
        message: failure.message,
      }),
    );
  }
}

export function IssuesSelectionBar({
  projectId,
  factory,
  selected,
  sendable,
  onSent,
  onDeleted,
  onClear,
}: {
  projectId: string;
  factory: IssueFactory;
  /** Every selected issue (all of them can be deleted). */
  selected: number[];
  /** The selected issues that can go to the factory. */
  sendable: number[];
  /** The issues the factory accepted (they leave the selection). */
  onSent: (accepted: number[]) => void;
  /** The issues GitHub deleted (they leave the selection and the list). */
  onDeleted: (deleted: number[]) => void;
  onClear: () => void;
}) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const remove = () => {
    setDeleting(true);
    void api.githubDeleteIssues(projectId, selected).match(
      (result) => {
        setDeleting(false);
        setConfirming(false);
        if (result.failed.length > 0) {
          log.warn('some issues were not deleted', { projectId, failed: result.failed.length });
        }
        reportDelete(t, result);
        onDeleted(result.deleted);
      },
      (error) => {
        setDeleting(false);
        setConfirming(false);
        toastError(error, 'issues');
      },
    );
  };

  return (
    <div
      className="border-sidebar-border bg-sidebar flex flex-col gap-1.5 border-t px-2 py-1.5 text-xs"
      data-testid="issues-selection-bar"
    >
      {factory.settings && sendable.length > 0 && (
        <IssuesFactoryBar
          projectId={projectId}
          settings={factory.settings}
          selected={sendable}
          onSent={onSent}
        />
      )}
      <div className="flex items-center gap-1.5">
        <span className="text-muted-foreground" data-testid="issues-selection-count">
          {t('issues.selectedCount', { count: selected.length })}
        </span>
        <Button variant="muted" size="xs" onClick={onClear} data-testid="issues-selection-clear">
          {t('issues.clearSelection')}
        </Button>
        <div className="min-w-0 flex-1" />
        <Button
          variant="destructive"
          size="xs"
          onClick={() => setConfirming(true)}
          disabled={deleting}
          data-testid="issues-selection-delete"
        >
          <Trash2 className="icon-xs" />
          {t('issues.delete')}
        </Button>
      </div>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t('issues.deleteTitle', { count: selected.length })}
        description={t('issues.deleteDesc', {
          issues: selected.map((n) => `#${n}`).join(', '),
        })}
        warning={t('issues.deleteWarning')}
        cancelLabel={t('common.cancel', 'Cancel')}
        confirmLabel={t('issues.delete')}
        loading={deleting}
        onCancel={() => setConfirming(false)}
        onConfirm={remove}
      />
    </div>
  );
}
