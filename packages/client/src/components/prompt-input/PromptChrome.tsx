/** Small presentational pieces around the PromptInputUI prompt box. */
import { useTranslation } from 'react-i18next';

import { ConfirmDialog } from '@/components/ConfirmDialog';
import type { ModelSelectGroup } from '@/components/PromptSelectors';
import { ProviderSetupDialog } from '@/components/ProviderSetupDialog';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';

interface PromptContextBarProps {
  show: boolean;
  children?: React.ReactNode;
  createWorktree: boolean;
  onCreateWorktreeChange?: (v: boolean) => void;
}

const noop = () => {};

/**
 * Top context bar — project / repo / branch + worktree switch. Sits visually
 * OUTSIDE the bordered prompt box (new threads only). Reserves the loaded
 * controls' height while repo/branch data loads.
 */
export function PromptContextBar({
  show,
  children,
  createWorktree,
  onCreateWorktreeChange,
}: PromptContextBarProps) {
  const { t } = useTranslation();
  if (!show) return null;
  return (
    <div
      className="text-muted-foreground mb-3 flex min-h-6 items-center gap-2 px-1 text-sm"
      data-testid="new-thread-context-bar"
    >
      <div className="no-scrollbar flex min-w-0 items-center gap-2 overflow-x-auto">{children}</div>
      <label className="flex shrink-0 cursor-pointer items-center gap-1.5">
        <Switch
          data-testid="prompt-worktree-switch"
          checked={createWorktree}
          onCheckedChange={onCreateWorktreeChange ?? noop}
          tabIndex={-1}
          className="scale-90"
        />
        <span>{t('thread.mode.worktree')}</span>
      </label>
    </div>
  );
}

interface ProviderSetupPromptProps {
  open: boolean;
  provider: string;
  modelGroups: ModelSelectGroup[];
  projectId?: string;
  onClose: () => void;
}

export function ProviderSetupPrompt({
  open,
  provider,
  modelGroups,
  projectId,
  onClose,
}: ProviderSetupPromptProps) {
  if (!open) return null;
  const label = modelGroups.find((group) => group.provider === provider)?.providerLabel ?? provider;
  return (
    <ProviderSetupDialog
      key={provider}
      provider={provider}
      label={label}
      projectId={projectId}
      onClose={onClose}
    />
  );
}

interface CompactConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCompact?: () => void;
}

/** Compaction is irreversible (older messages get summarized), so confirm first. */
export function CompactConfirmDialog({ open, onOpenChange, onCompact }: CompactConfirmDialogProps) {
  const { t } = useTranslation();
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('prompt.compactConfirmTitle', 'Compact conversation?')}
      description={t(
        'prompt.compactConfirmBody',
        'This summarizes the current conversation to free up context. Earlier messages are condensed and the full detail is no longer available to the agent.',
      )}
      cancelLabel={t('common.cancel', 'Cancel')}
      confirmLabel={t('prompt.compactConfirmAction', 'Compact')}
      variant="default"
      onCancel={() => onOpenChange(false)}
      onConfirm={() => {
        onOpenChange(false);
        onCompact?.();
      }}
    />
  );
}

interface PromptBoxProps {
  boxRef: React.RefObject<HTMLDivElement | null>;
  isDragging: boolean;
  onClick: (e: React.MouseEvent<HTMLDivElement>) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
  children: React.ReactNode;
}

/** Bordered editor + toolbar container; highlights while files are dragged over it. */
export function PromptBox({
  boxRef,
  isDragging,
  onClick,
  onDragOver,
  onDragLeave,
  onDrop,
  children,
}: PromptBoxProps) {
  return (
    // This wrapper only forwards blank-area clicks to the nested editor; it is not a separate control.
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
    // react-doctor-disable-next-line react-doctor/no-static-element-interactions
    <div
      ref={boxRef}
      className={cn(
        'relative cursor-text rounded-md border bg-input/80',
        isDragging
          ? 'border-primary border-2 ring-2 ring-primary/20'
          : 'border-border/80 focus-within:border-ring focus-within:ring-1 focus-within:ring-ring/50',
      )}
      onClick={onClick}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {children}
    </div>
  );
}

interface PromptInputFrameProps {
  isNewThread: boolean;
  children: React.ReactNode;
  /** Dialogs rendered after the content column, inside the outer wrapper. */
  overlays?: React.ReactNode;
}

/** Outer padding / max-width wrappers (tighter for the new-thread composer). */
export function PromptInputFrame({ isNewThread, children, overlays }: PromptInputFrameProps) {
  return (
    <div className={cn(!isNewThread && 'px-3 sm:px-4')}>
      <div className={cn('mx-auto w-full max-w-3xl min-w-0', isNewThread ? 'pb-0' : 'pb-4')}>
        {children}
      </div>
      {overlays}
    </div>
  );
}
