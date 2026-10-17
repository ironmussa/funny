import type { QueuedMessage } from '@funny/shared';
import { Check, ListOrdered, Loader2, Pencil, Trash2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

import type { QueueEditing } from './use-queue-editing';

interface QueueIconButtonProps {
  testId: string;
  label: string;
  onClick: () => void;
  disabled: boolean;
  variant?: 'ghost';
  className: string;
  children: React.ReactNode;
}

function QueueIconButton({
  testId,
  label,
  onClick,
  disabled,
  variant,
  className,
  children,
}: QueueIconButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          data-testid={testId}
          type="button"
          variant={variant}
          size="icon-xs"
          onClick={onClick}
          disabled={disabled}
          aria-label={label}
          className={className}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function BusyIcon({ busy, children }: { busy: boolean; children: React.ReactNode }) {
  return busy ? <Loader2 className="icon-xs animate-spin" /> : children;
}

function QueueIndex({ index }: { index: number }) {
  return (
    <span className="text-muted-foreground shrink-0 text-[10px] font-medium tracking-wide uppercase">
      #{index + 1}
    </span>
  );
}

interface QueueItemProps {
  message: QueuedMessage;
  index: number;
  queue: QueueEditing;
}

function QueueItemEditor({ message, index, queue }: QueueItemProps) {
  const { t } = useTranslation();
  const isBusy = queue.busyId === message.id;
  return (
    <div className="flex items-center gap-2">
      <QueueIndex index={index} />
      <Input
        data-testid={`queue-edit-textarea-${message.id}`}
        value={queue.editingContent}
        onChange={(event) => queue.setEditingContent(event.target.value)}
        disabled={isBusy}
        className="bg-background h-7 flex-1 text-xs"
      />
      <div className="flex shrink-0 items-center gap-0.5">
        <QueueIconButton
          testId={`queue-save-${message.id}`}
          label={t('prompt.saveQueuedMessage', 'Save')}
          onClick={() => queue.saveEdit(message.id)}
          disabled={isBusy}
          className="text-muted-foreground hover:text-foreground"
        >
          <BusyIcon busy={isBusy}>
            <Check className="icon-xs" />
          </BusyIcon>
        </QueueIconButton>
        <QueueIconButton
          testId={`queue-cancel-edit-${message.id}`}
          label={t('prompt.cancelQueuedEdit', 'Cancel')}
          variant="ghost"
          onClick={queue.cancelEdit}
          disabled={isBusy}
          className="text-muted-foreground hover:text-foreground"
        >
          <X className="icon-xs" />
        </QueueIconButton>
      </div>
    </div>
  );
}

function QueueItemView({ message, index, queue }: QueueItemProps) {
  const { t } = useTranslation();
  const isBusy = queue.busyId === message.id;
  const actionsDisabled = isBusy || message.id.startsWith('preview-queued-message:');
  return (
    <div className="flex items-center gap-2">
      <QueueIndex index={index} />
      <Tooltip>
        <TooltipTrigger asChild>
          <p className="text-muted-foreground min-w-0 flex-1 truncate text-xs">{message.content}</p>
        </TooltipTrigger>
        <TooltipContent className="max-w-[min(36rem,calc(100vw-2rem))] break-words">
          {message.content}
        </TooltipContent>
      </Tooltip>
      <div className="flex shrink-0 items-center gap-0.5">
        <QueueIconButton
          testId={`queue-edit-${message.id}`}
          label={t('prompt.editQueuedMessage', 'Edit')}
          variant="ghost"
          onClick={() => queue.startEdit(message)}
          disabled={actionsDisabled}
          className="text-muted-foreground hover:text-foreground"
        >
          <Pencil className="icon-xs" />
        </QueueIconButton>
        <QueueIconButton
          testId={`queue-delete-${message.id}`}
          label={t('prompt.deleteQueuedMessage', 'Delete')}
          variant="ghost"
          onClick={() => queue.deleteMessage(message.id)}
          disabled={actionsDisabled}
          className="text-destructive hover:text-destructive"
        >
          <BusyIcon busy={isBusy}>
            <Trash2 className="icon-xs" />
          </BusyIcon>
        </QueueIconButton>
      </div>
    </div>
  );
}

interface QueueIndicatorProps {
  queuedCount: number;
  queuedMessages: QueuedMessage[];
  queueLoading: boolean;
  queue: QueueEditing;
}

/** Queued follow-up messages shown above the prompt box. */
export function QueueIndicator({
  queuedCount,
  queuedMessages,
  queueLoading,
  queue,
}: QueueIndicatorProps) {
  const { t } = useTranslation();
  if (queuedCount === 0 && queuedMessages.length === 0) return null;
  const count = queuedMessages.length > 0 ? queuedMessages.length : queuedCount;

  return (
    <div
      data-testid="queue-indicator"
      className="border-border/40 mb-2 space-y-2 rounded-md border px-2.5 py-2"
    >
      <div className="flex items-center gap-1.5">
        <ListOrdered className="icon-xs text-muted-foreground shrink-0" />
        <span className="text-muted-foreground text-xs">
          {count === 1
            ? t('prompt.queuedOne', '1 message in queue')
            : t('prompt.queuedMany', '{{count}} messages in queue', { count })}
        </span>
      </div>

      {queueLoading && queuedMessages.length === 0 ? (
        <div className="border-border/60 bg-background/60 text-muted-foreground flex items-center gap-2 rounded-md border border-dashed px-3 py-2 text-xs">
          <Loader2 className="icon-xs animate-spin" />
          {t('prompt.loadingQueuedMessages', 'Loading queued messages...')}
        </div>
      ) : (
        <div className="divide-border divide-y *:bg-transparent">
          {queuedMessages.map((message, index) => {
            const Row = queue.editingId === message.id ? QueueItemEditor : QueueItemView;
            return (
              <div
                key={message.id}
                data-testid={`queue-item-${message.id}`}
                className="bg-transparent px-1 py-1 first:pt-0 last:pb-0"
              >
                <Row message={message} index={index} queue={queue} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
