import type { Dispatch, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';

import { ConfirmDialog } from '@/components/ConfirmDialog';
import { PublishRepoDialog } from '@/components/PublishRepoDialog';
import { PullStrategyDialog } from '@/components/pull-strategy-dialog';
import type { PullStrategy } from '@/lib/api';

import { CreatePRDialog, MergeBranchDialog } from './ReviewActionDialogs';

export type ConfirmDialogState = {
  type: 'revert' | 'reset' | 'discard-all' | 'drop-stash' | 'ignore';
  path?: string;
  paths?: string[];
  stashIndex?: string;
};

interface ReviewDialogsProps {
  // Confirm (destructive actions)
  confirmDialog: ConfirmDialogState | null;
  setConfirmDialog: Dispatch<SetStateAction<ConfirmDialogState | null>>;
  executeRevert: (path: string) => Promise<void>;
  executeDiscardAll: (paths: string[]) => Promise<void>;
  executeIgnoreFiles: (paths: string[]) => Promise<void>;
  executeResetSoft: () => Promise<void>;
  executeStashDrop: (stashIndex: string) => Promise<void>;

  // Pull strategy
  pullStrategyDialog: { open: boolean; errorMessage: string };
  setPullStrategyDialog: Dispatch<SetStateAction<{ open: boolean; errorMessage: string }>>;
  handlePullStrategyChosen: (strategy: Exclude<PullStrategy, 'ff-only'>) => Promise<void>;

  // Create PR
  prDialog: { title: string; body: string } | null;
  setPrDialog: Dispatch<SetStateAction<{ title: string; body: string } | null>>;
  threadBranch: string | undefined;
  baseBranch: string | undefined;
  prInProgress: boolean;
  handleCreatePROnly: () => void;

  // Merge
  mergeDialog: { targetBranch: string; branches: string[]; loading: boolean } | null;
  setMergeDialog: Dispatch<
    SetStateAction<{ targetBranch: string; branches: string[]; loading: boolean } | null>
  >;
  currentBranch: string | undefined;
  mergeInProgress: boolean;
  handleMergeWithTarget: () => void;

  // Publish repo
  publishProjectId: string;
  publishProjectPath: string;
  publishDialogOpen: boolean;
  setPublishDialogOpen: (open: boolean) => void;
  handlePublishSuccess: (repoUrl: string) => void;
}

/**
 * Bundles the five dialogs that hang off ReviewPane (confirm, pull-strategy,
 * create-PR, merge, publish-repo) so the orchestrator stays focused on layout.
 */
export function ReviewDialogs({
  confirmDialog,
  setConfirmDialog,
  executeRevert,
  executeDiscardAll,
  executeIgnoreFiles,
  executeResetSoft,
  executeStashDrop,
  pullStrategyDialog,
  setPullStrategyDialog,
  handlePullStrategyChosen,
  prDialog,
  setPrDialog,
  threadBranch,
  baseBranch,
  prInProgress,
  handleCreatePROnly,
  mergeDialog,
  setMergeDialog,
  currentBranch,
  mergeInProgress,
  handleMergeWithTarget,
  publishProjectId,
  publishProjectPath,
  publishDialogOpen,
  setPublishDialogOpen,
  handlePublishSuccess,
}: ReviewDialogsProps) {
  const { t } = useTranslation();

  return (
    <>
      <ConfirmDialog
        open={!!confirmDialog}
        onOpenChange={(open) => {
          if (!open) setConfirmDialog(null);
        }}
        title={
          confirmDialog?.type === 'revert' || confirmDialog?.type === 'discard-all'
            ? t('review.discardChanges', 'Discard changes')
            : confirmDialog?.type === 'ignore'
              ? 'Add to .gitignore'
              : confirmDialog?.type === 'drop-stash'
                ? t('review.dropStashTitle', 'Discard stash')
                : t('review.undoLastCommit', 'Undo last commit')
        }
        description={
          // oxlint-disable-next-line anti-slop-effect/prefer-effect-match -- plain literal ternary, not an Effect tagged union
          confirmDialog?.type === 'revert'
            ? t('review.revertConfirm', { paths: confirmDialog?.path })
            : confirmDialog?.type === 'discard-all'
              ? t('review.discardAllConfirm', {
                  count: confirmDialog?.paths?.length,
                  defaultValue: `Discard changes in ${confirmDialog?.paths?.length} file(s)? This cannot be undone.`,
                })
              : confirmDialog?.type === 'ignore'
                ? `Add ${confirmDialog?.paths?.length} file(s) to .gitignore?`
                : confirmDialog?.type === 'drop-stash'
                  ? t('review.dropStashConfirm', 'Drop this stash entry? This cannot be undone.')
                  : t('review.resetSoftConfirm', 'Undo the last commit? Changes will be kept.')
        }
        cancelLabel={t('common.cancel', 'Cancel')}
        confirmLabel={t('common.confirm', 'Confirm')}
        onCancel={() => setConfirmDialog(null)}
        onConfirm={async () => {
          const dialog = confirmDialog;
          setConfirmDialog(null);
          if (dialog?.type === 'revert' && dialog.path) {
            await executeRevert(dialog.path);
          } else if (dialog?.type === 'discard-all' && dialog.paths) {
            await executeDiscardAll(dialog.paths);
          } else if (dialog?.type === 'reset') {
            await executeResetSoft();
          } else if (dialog?.type === 'ignore' && dialog.paths) {
            await executeIgnoreFiles(dialog.paths);
          } else if (dialog?.type === 'drop-stash' && dialog.stashIndex != null) {
            await executeStashDrop(dialog.stashIndex);
          }
        }}
      />

      <PullStrategyDialog
        open={pullStrategyDialog.open}
        onOpenChange={(open) => setPullStrategyDialog((s) => ({ ...s, open }))}
        errorMessage={pullStrategyDialog.errorMessage}
        onChoose={handlePullStrategyChosen}
      />

      <CreatePRDialog
        prDialog={prDialog}
        setPrDialog={setPrDialog}
        threadBranch={threadBranch}
        baseBranch={baseBranch}
        prInProgress={prInProgress}
        handleCreatePROnly={handleCreatePROnly}
      />

      <MergeBranchDialog
        mergeDialog={mergeDialog}
        setMergeDialog={setMergeDialog}
        currentBranch={currentBranch}
        mergeInProgress={mergeInProgress}
        handleMergeWithTarget={handleMergeWithTarget}
      />

      <PublishRepoDialog
        projectId={publishProjectId}
        projectPath={publishProjectPath}
        open={publishDialogOpen}
        onOpenChange={setPublishDialogOpen}
        onSuccess={handlePublishSuccess}
      />
    </>
  );
}
