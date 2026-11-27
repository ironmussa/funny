import type { DeleteIssuesResult } from '@funny/shared/contracts/github-issues';
/**
 * The row that takes the filters' place above the issues while some are
 * selected: how many, clear the selection, send the ones that can go to the
 * factory, and delete them all on GitHub after a confirmation.
 */
import type { TFunction } from 'i18next';
import { Factory, Trash2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
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

/** Why "Send to factory" is off, or null: no factory yet, or nothing open to send. */
function sendOffReason(t: TFunction, factory: IssueFactory, sendable: number[]): string | null {
  if (!factory.settings) {
    return t('factory.notConfigured', 'Set up the issue factory in the project settings first.');
  }
  return sendable.length === 0
    ? t('factory.nothingToSend', 'Only open issues can go to the factory.')
    : null;
}

/** Deleting the selection on GitHub, behind its confirmation. */
function useDeleteSelection(
  projectId: string,
  selected: number[],
  onDeleted: (deleted: number[]) => void,
) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const done = () => {
    setDeleting(false);
    setConfirming(false);
  };
  const remove = () => {
    setDeleting(true);
    void api.githubDeleteIssues(projectId, selected).match(
      (result) => {
        done();
        if (result.failed.length > 0) {
          log.warn('some issues were not deleted', { projectId, failed: result.failed.length });
        }
        reportDelete(t, result);
        onDeleted(result.deleted);
      },
      (error) => {
        done();
        toastError(error, 'issues');
      },
    );
  };
  return { confirming, setConfirming, deleting, remove };
}

/** "Send to factory", with how many of the selection can go and why it is off. */
function SendToFactoryButton({
  sendOff,
  sendableCount,
  selectedCount,
  onSend,
}: {
  sendOff: string | null;
  sendableCount: number;
  selectedCount: number;
  onSend: () => void;
}) {
  const { t } = useTranslation();
  const partial = sendableCount > 0 && sendableCount < selectedCount;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* A disabled button gets no pointer events: the span keeps the tooltip. */}
        <span>
          <Button
            size="xs"
            onClick={onSend}
            disabled={sendOff !== null}
            data-testid="issues-selection-send-factory"
          >
            <Factory className="icon-xs" />
            {t('factory.send', 'Send to factory')}
            {partial ? ` (${sendableCount})` : ''}
          </Button>
        </span>
      </TooltipTrigger>
      {sendOff && <TooltipContent side="bottom">{sendOff}</TooltipContent>}
    </Tooltip>
  );
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
  leading,
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
  /** Shown before the count: the select-all checkbox. */
  leading?: ReactNode;
}) {
  const { t } = useTranslation();
  const { confirming, setConfirming, deleting, remove } = useDeleteSelection(
    projectId,
    selected,
    onDeleted,
  );
  const [sending, setSending] = useState(false);
  const sendOff = sendOffReason(t, factory, sendable);

  return (
    <div
      className="border-sidebar-border flex flex-col gap-1.5 border-b px-2 py-1.5 text-xs"
      data-testid="issues-selection-bar"
    >
      <div className="flex min-h-6 items-center gap-1.5">
        {leading}
        <span className="text-muted-foreground" data-testid="issues-selection-count">
          {t('issues.selectedCount', { count: selected.length })}
        </span>
        <Button variant="muted" size="xs" onClick={onClear} data-testid="issues-selection-clear">
          {t('issues.clearSelection')}
        </Button>
        <div className="min-w-0 flex-1" />
        <SendToFactoryButton
          sendOff={sendOff}
          sendableCount={sendable.length}
          selectedCount={selected.length}
          onSend={() => setSending(true)}
        />
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
