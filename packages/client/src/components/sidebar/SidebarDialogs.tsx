import type { Dispatch, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';

import { ConfirmDialog } from '@/components/ConfirmDialog';
import { IssuesDialog } from '@/components/IssuesDialog';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { WorktreeDeleteDialog } from '@/components/WorktreeDeleteDialog';
import { useUIStore } from '@/stores/ui-store';

export interface ArchiveConfirmState {
  threadId: string;
  projectId: string;
  title: string;
  isWorktree?: boolean;
}

export interface DeleteThreadConfirmState {
  threadId: string;
  projectId: string;
  title: string;
  isWorktree?: boolean;
  worktreePath?: string | null;
  branchName?: string | null;
}

export interface RenameProjectState {
  projectId: string;
  currentName: string;
  newName: string;
}

export interface DeleteProjectConfirmState {
  projectId: string;
  name: string;
}

interface SidebarDialogsProps {
  archiveConfirm: ArchiveConfirmState | null;
  setArchiveConfirm: Dispatch<SetStateAction<ArchiveConfirmState | null>>;
  handleArchiveConfirm: () => void;

  deleteThreadConfirm: DeleteThreadConfirmState | null;
  setDeleteThreadConfirm: Dispatch<SetStateAction<DeleteThreadConfirmState | null>>;
  handleDeleteThreadConfirm: (opts?: { deleteBranch?: boolean }) => void;

  renameProjectState: RenameProjectState | null;
  setRenameProjectState: Dispatch<SetStateAction<RenameProjectState | null>>;
  handleRenameProjectConfirm: () => void;

  deleteProjectConfirm: DeleteProjectConfirmState | null;
  setDeleteProjectConfirm: Dispatch<SetStateAction<DeleteProjectConfirmState | null>>;
  handleDeleteProjectConfirm: () => void;

  issuesProjectId: string | null;
  setIssuesProjectId: Dispatch<SetStateAction<string | null>>;

  actionLoading: boolean;
}

/**
 * The four destructive-action dialogs at the bottom of AppSidebar:
 * archive thread, delete thread (worktree-aware), rename project, delete
 * project. The state and handlers live in the parent because they're
 * triggered from row context menus deep inside ProjectItem / ThreadList.
 *
 * Extracted from Sidebar.tsx as part of the god-file split.
 */
export function SidebarDialogs({
  archiveConfirm,
  setArchiveConfirm,
  handleArchiveConfirm,
  deleteThreadConfirm,
  setDeleteThreadConfirm,
  handleDeleteThreadConfirm,
  renameProjectState,
  setRenameProjectState,
  handleRenameProjectConfirm,
  deleteProjectConfirm,
  setDeleteProjectConfirm,
  handleDeleteProjectConfirm,
  issuesProjectId,
  setIssuesProjectId,
  actionLoading,
}: SidebarDialogsProps) {
  const { t } = useTranslation();
  return (
    <>
      {/* Archive confirmation dialog */}
      <ConfirmDialog
        open={!!archiveConfirm}
        onOpenChange={(open) => {
          if (!open) setArchiveConfirm(null);
        }}
        title={t('dialog.archiveThread')}
        description={t('dialog.archiveThreadDesc', {
          title:
            archiveConfirm?.title && archiveConfirm.title.length > 80
              ? archiveConfirm.title.slice(0, 80) + '…'
              : archiveConfirm?.title,
        })}
        warning={archiveConfirm?.isWorktree ? t('dialog.worktreeWarning') : undefined}
        cancelLabel={t('common.cancel')}
        confirmLabel={t('sidebar.archive')}
        variant="default"
        loading={actionLoading}
        onCancel={() => setArchiveConfirm(null)}
        onConfirm={handleArchiveConfirm}
      />

      {/* Delete thread confirmation dialog — enhanced for worktree threads */}
      {deleteThreadConfirm?.isWorktree ? (
        <WorktreeDeleteDialog
          open={!!deleteThreadConfirm}
          target={deleteThreadConfirm}
          loading={actionLoading}
          onCancel={() => setDeleteThreadConfirm(null)}
          onConfirm={({ deleteBranch }) => handleDeleteThreadConfirm({ deleteBranch })}
        />
      ) : (
        <ConfirmDialog
          open={!!deleteThreadConfirm}
          onOpenChange={(open) => {
            if (!open) setDeleteThreadConfirm(null);
          }}
          title={t('dialog.deleteThread')}
          description={t('dialog.deleteThreadDesc', {
            title:
              deleteThreadConfirm?.title && deleteThreadConfirm.title.length > 80
                ? deleteThreadConfirm.title.slice(0, 80) + '…'
                : deleteThreadConfirm?.title,
          })}
          cancelLabel={t('common.cancel')}
          confirmLabel={t('common.delete')}
          loading={actionLoading}
          onCancel={() => setDeleteThreadConfirm(null)}
          onConfirm={() => handleDeleteThreadConfirm()}
        />
      )}

      {/* Rename project dialog */}
      <Dialog
        open={!!renameProjectState}
        onOpenChange={(open) => {
          if (!open) setRenameProjectState(null);
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('dialog.renameProject')}</DialogTitle>
            <DialogDescription>
              {t('dialog.renameProjectDesc', { name: renameProjectState?.currentName })}
            </DialogDescription>
          </DialogHeader>
          <div className="py-2">
            <Input
              data-testid="rename-project-input"
              value={renameProjectState?.newName || ''}
              onChange={(e) => {
                const value = e.target.value;
                setRenameProjectState((prev) => (prev ? { ...prev, newName: value } : prev));
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  handleRenameProjectConfirm();
                }
              }}
              placeholder={t('sidebar.projectName')}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button
              data-testid="rename-project-cancel"
              variant="outline"
              size="sm"
              onClick={() => setRenameProjectState(null)}
            >
              {t('common.cancel')}
            </Button>
            <Button
              data-testid="rename-project-confirm"
              size="sm"
              onClick={handleRenameProjectConfirm}
              loading={actionLoading}
            >
              {t('common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete project confirmation dialog */}
      <ConfirmDialog
        open={!!deleteProjectConfirm}
        onOpenChange={(open) => {
          if (!open) setDeleteProjectConfirm(null);
        }}
        title={t('dialog.deleteProject')}
        description={t('dialog.deleteProjectDesc', { name: deleteProjectConfirm?.name })}
        cancelLabel={t('common.cancel')}
        confirmLabel={t('common.delete')}
        loading={actionLoading}
        onCancel={() => setDeleteProjectConfirm(null)}
        onConfirm={handleDeleteProjectConfirm}
      />

      {issuesProjectId && (
        <IssuesDialog
          projectId={issuesProjectId}
          open={!!issuesProjectId}
          onOpenChange={(open) => {
            if (!open) setIssuesProjectId(null);
          }}
          onCreateThread={(params) => {
            setIssuesProjectId(null);
            useUIStore.getState().startNewThreadFromIssue(issuesProjectId, params);
          }}
        />
      )}
    </>
  );
}
