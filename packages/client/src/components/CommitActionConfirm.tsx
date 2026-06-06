import { useTranslation } from 'react-i18next';

import { ConfirmDialog } from '@/components/ConfirmDialog';
import type { PendingCommitAction } from '@/hooks/use-commit-actions';

interface Props {
  /** The pending action (null = dialog closed). */
  pending: PendingCommitAction | null;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Confirmation dialog for the three destructive commit operations
 * (checkout / revert / hard reset). Shared by {@link CommitActionsMenu} and the
 * CommitDetailDialog so the wording + destructive styling live in exactly one
 * place. Driven by `pending` from {@link useCommitActions}.
 */
export function CommitActionConfirm({ pending, onConfirm, onCancel }: Props) {
  const { t } = useTranslation();

  const config = pending
    ? {
        checkout: {
          title: t('history.confirmCheckoutTitle', 'Checkout Commit'),
          description: t(
            'history.confirmCheckoutDesc',
            'This will switch to a detached HEAD at this commit. Any uncommitted changes may be lost. Continue?',
          ),
          confirmLabel: t('history.confirmCheckoutButton', 'Checkout'),
          variant: 'default' as const,
        },
        revert: {
          title: t('history.confirmRevertTitle', 'Revert Commit'),
          description: t(
            'history.confirmRevertDesc',
            'This will create a new commit that undoes the changes from this commit. Continue?',
          ),
          confirmLabel: t('history.confirmRevertButton', 'Revert'),
          variant: 'default' as const,
        },
        reset: {
          title: t('history.confirmResetTitle', 'Hard Reset Branch'),
          description: t(
            'history.confirmResetDesc',
            'Are you sure you want to hard reset the current branch to this commit? This will discard all changes and commits after this point. This action cannot be undone.',
          ),
          confirmLabel: t('history.confirmResetButton', 'Reset Branch'),
          variant: 'destructive' as const,
        },
      }[pending.kind]
    : null;

  return (
    <ConfirmDialog
      open={!!pending}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      title={config?.title ?? ''}
      description={config?.description ?? ''}
      confirmLabel={config?.confirmLabel}
      variant={config?.variant ?? 'destructive'}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}
