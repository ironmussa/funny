import type { DeleteIssuesResult } from '@funny/shared/contracts/github-issues';
/**
 * The bar under the issues while some are selected: how many, clear the
 * selection, send the ones that can go to the factory, and delete them all on
 * GitHub after a confirmation.
 */
import type { TFunction } from 'i18next';
import { Factory, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ConfirmDialog } from '@/components/ConfirmDialog';
import {
  IssuesFactorySendDialog,
  type IssueFactory,
} from '@/components/issues/IssueFactoryControls';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
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
  labelsOf,
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
  /** The GitHub labels an issue of the list carries now. */
  labelsOf: (issueNumber: number) => string[];
  /** The issues the factory accepted (they leave the selection). */
  onSent: (accepted: number[]) => void;
  /** The issues GitHub deleted (they leave the selection and the list). */
  onDeleted: (deleted: number[]) => void;
  onClear: () => void;
}) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [sending, setSending] = useState(false);
  // Why "Send to factory" is off, or null: no factory yet, or nothing open to send.
  const sendOff = !factory.settings
    ? t('factory.notConfigured', 'Set up the issue factory in the project settings first.')
    : sendable.length === 0
      ? t('factory.nothingToSend', 'Only open issues can go to the factory.')
      : null;

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
      <div className="flex items-center gap-1.5">
        <span className="text-muted-foreground" data-testid="issues-selection-count">
          {t('issues.selectedCount', { count: selected.length })}
        </span>
        <Button variant="muted" size="xs" onClick={onClear} data-testid="issues-selection-clear">
          {t('issues.clearSelection')}
        </Button>
        <div className="min-w-0 flex-1" />
        <Tooltip>
          <TooltipTrigger asChild>
            {/* A disabled button gets no pointer events: the span keeps the tooltip. */}
            <span>
              <Button
                size="xs"
                onClick={() => setSending(true)}
                disabled={sendOff !== null}
                data-testid="issues-selection-send-factory"
              >
                <Factory className="icon-xs" />
                {t('factory.send', 'Send to factory')}
                {sendable.length > 0 && sendable.length < selected.length
                  ? ` (${sendable.length})`
                  : ''}
              </Button>
            </span>
          </TooltipTrigger>
          {sendOff && <TooltipContent side="top">{sendOff}</TooltipContent>}
        </Tooltip>
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
      {factory.settings && sendable.length > 0 && (
        <IssuesFactorySendDialog
          open={sending}
          onOpenChange={setSending}
          projectId={projectId}
          settings={factory.settings}
          selected={sendable}
          labelsOf={labelsOf}
          onSent={onSent}
        />
      )}
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
