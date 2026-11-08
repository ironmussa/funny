import {
  Trash2,
  Plus,
  Loader2,
  AlertCircle,
  GitFork,
  FolderOpen,
  ChevronUp,
  GitCommitHorizontal,
} from 'lucide-react';
import { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { LabelBadge } from '@/components/ui/label-badge';
import { LoadingState } from '@/components/ui/loading-state';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useProjects } from '@/data/projects/hooks';
import { api } from '@/lib/api';
import { useAppStore } from '@/stores/app-store';

import { BranchPicker } from './SearchablePicker';

interface WorktreeInfo {
  path: string;
  branch: string;
  commit: string;
  isMain: boolean;
}

function WorktreeCard({
  worktree,
  onRemove,
  removing,
  active,
  readOnly,
}: {
  worktree: WorktreeInfo;
  onRemove: () => void;
  removing: boolean;
  active: boolean;
  readOnly: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="group hover:bg-sidebar-accent/50 flex w-full items-start gap-2 px-3 py-2.5 text-xs transition-colors">
      <div className="flex min-w-0 flex-1 items-start gap-2">
        <GitFork className="icon-sm text-status-info mt-0.5 shrink-0" />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-foreground min-w-0 text-[11px] leading-5 font-medium break-words">
              {worktree.branch}
            </span>
            {worktree.isMain && (
              <LabelBadge
                color="#7CB9E8"
                title={t('worktreeSettings.mainDescription')}
                data-testid="worktree-badge-main"
              >
                {t('worktreeSettings.main')}
              </LabelBadge>
            )}
            {active && (
              <LabelBadge
                color="#A8D5A2"
                title={t('worktreeSettings.activeDescription')}
                data-testid="worktree-badge-active"
              >
                {t('worktreeSettings.active')}
              </LabelBadge>
            )}
          </div>
          <div className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-[10px]">
            <FolderOpen className="icon-xs text-muted-foreground/70 shrink-0" />
            <span title={worktree.path} className="truncate font-mono">
              {worktree.path}
            </span>
          </div>
          {worktree.commit && (
            <span
              className="text-muted-foreground flex items-center gap-1.5 text-[10px]"
              title={worktree.commit}
            >
              <GitCommitHorizontal className="icon-xs shrink-0" />
              <span className="font-mono">{worktree.commit.slice(0, 8)}</span>
            </span>
          )}
        </div>
      </div>
      {!readOnly && !worktree.isMain && (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t('dialog.deleteWorktree')}
          title={t('dialog.deleteWorktree')}
          onClick={onRemove}
          disabled={removing}
          className="text-muted-foreground hover:text-destructive shrink-0"
        >
          {removing ? <Loader2 className="icon-sm animate-spin" /> : <Trash2 className="icon-sm" />}
        </Button>
      )}
    </div>
  );
}

function WorktreeCreateForm({
  branches,
  branchName,
  baseBranch,
  creating,
  onBranchNameChange,
  onBaseBranchChange,
  onCreate,
}: {
  branches: string[];
  branchName: string;
  baseBranch: string;
  creating: boolean;
  onBranchNameChange: (value: string) => void;
  onBaseBranchChange: (value: string) => void;
  onCreate: () => void;
}) {
  const { t } = useTranslation();
  return branches.length === 0 ? (
    <div className="bg-status-pending/10 text-status-pending/80 mb-3 flex items-center gap-2 rounded-md px-3 py-2 text-xs">
      <AlertCircle className="icon-sm shrink-0" />
      <span>No branches found. Make sure the project has at least one commit.</span>
    </div>
  ) : (
    <div className="border-sidebar-border bg-sidebar-accent/30 space-y-3 border-b p-3">
      <div>
        <label htmlFor="worktree-branch-name" className="text-muted-foreground mb-1 block text-xs">
          {t('worktreeSettings.branchName')}
        </label>
        <Input
          id="worktree-branch-name"
          type="text"
          value={branchName}
          onChange={(e) => onBranchNameChange(e.target.value)}
          placeholder="feature/my-new-branch"
          className="h-8 px-2 font-mono text-xs"
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === 'Enter') onCreate();
          }}
        />
      </div>

      <fieldset>
        <legend className="text-muted-foreground mb-1 block text-xs">
          {t('worktreeSettings.baseBranch')}
        </legend>
        <BranchPicker
          branches={branches}
          selected={baseBranch}
          onChange={onBaseBranchChange}
          triggerClassName="flex h-8 w-full items-center gap-2 rounded-md border border-input bg-background px-3 text-xs transition-colors hover:bg-accent/50 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring/50"
          side="bottom"
          align="start"
          showCopy={false}
          placeholder="main (default)"
        />
      </fieldset>

      <Button
        size="sm"
        onClick={onCreate}
        disabled={!branchName.trim() || creating}
        className="w-full"
      >
        {creating ? (
          <Loader2 className="icon-xs mr-1 animate-spin" />
        ) : (
          <Plus className="icon-xs mr-1" />
        )}
        {creating ? t('worktreeSettings.creating') : t('worktreeSettings.createWorktree')}
      </Button>
    </div>
  );
}

export function WorktreeSettings({
  projectId,
  activePath,
  readOnly = false,
}: {
  projectId?: string;
  activePath?: string;
  readOnly?: boolean;
}) {
  const { t } = useTranslation();
  const projects = useProjects();
  const selectedProjectId = useAppStore((s) => s.selectedProjectId);
  const [worktrees, setWorktrees] = useState<WorktreeInfo[]>([]);
  const [branches, setBranches] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removingPath, setRemovingPath] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<WorktreeInfo | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [branchName, setBranchName] = useState('');
  const [baseBranch, setBaseBranch] = useState('');
  const [creating, setCreating] = useState(false);

  const targetProjectId = projectId ?? selectedProjectId;
  const project = targetProjectId
    ? projects.find((p) => p.id === targetProjectId)
    : projectId === undefined
      ? projects[0]
      : undefined;

  const loadWorktrees = useCallback(async () => {
    if (!project) return;
    setLoading(true);
    setError(null);
    try {
      const result = await api.listWorktrees(project.id);
      if (result.isOk()) setWorktrees(result.value);
      else setError(result.error.message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-run when project.id changes; project object is derived each render
  }, [project?.id]);

  const loadBranches = useCallback(async () => {
    if (!project) return;
    const result = await api.listBranches(project.id);
    if (result.isOk()) {
      const data = result.value;
      setBranches(data.branches);
      if (data.branches.length > 0) {
        setBaseBranch((prev) => prev || data.defaultBranch || data.branches[0]);
      }
    } else {
      console.error('Failed to load branches:', result.error);
      setError(result.error.message || 'Failed to load branches');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-run when project.id changes; project object is derived each render
  }, [project?.id]);

  useEffect(() => {
    loadWorktrees();
    loadBranches();
  }, [loadWorktrees, loadBranches]);

  const handleCreate = async () => {
    const effectiveBase = baseBranch || branches[0];
    if (readOnly || !branchName.trim() || !project) return;
    if (!effectiveBase) {
      setError('No base branch available. Make sure the project has at least one commit.');
      return;
    }
    setCreating(true);
    setError(null);
    const result = await api.createWorktree({
      projectId: project.id,
      branchName: branchName.trim(),
      baseBranch: effectiveBase,
    });
    if (result.isErr()) {
      setError(result.error.message);
    } else {
      await loadWorktrees();
      setBranchName('');
      setShowCreate(false);
    }
    setCreating(false);
  };

  const handleRemoveConfirmed = async () => {
    if (readOnly || !project || !confirmRemove) return;
    const { path: worktreePath, branch } = confirmRemove;
    setConfirmRemove(null);
    setRemovingPath(worktreePath);
    const result = await api.removeWorktree(project.id, worktreePath);
    if (result.isOk()) {
      await loadWorktrees();
      toast.success(t('toast.worktreeDeleted', { branch }));
    } else {
      toast.error(t('toast.worktreeDeleteFailed', { message: result.error.message }));
    }
    setRemovingPath(null);
  };

  if (!project) {
    return <EmptyState icon={GitFork} title={t('worktreeSettings.noProject')} />;
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col text-xs">
      {/* Error banner */}
      {error && (
        <div className="bg-destructive/10 text-destructive flex items-center gap-2 rounded-md px-3 py-2 text-xs">
          <AlertCircle className="icon-sm shrink-0" />
          <span>{error}</span>
          <button onClick={() => setError(null)} className="ml-auto text-xs underline">
            {t('worktreeSettings.dismiss')}
          </button>
        </div>
      )}

      {/* Worktree list */}
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="border-sidebar-border flex shrink-0 items-center gap-1.5 border-b px-2 py-1.5">
          <h3 className="text-muted-foreground flex min-w-0 flex-1 items-center gap-1.5 px-1 text-[11px]">
            {t('worktreeSettings.worktrees')}
            <span className="bg-sidebar-accent rounded px-1.5 text-[10px] tabular-nums">
              {worktrees.length}
            </span>
          </h3>
          {!readOnly && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowCreate(!showCreate)}
              className="text-muted-foreground h-6 shrink-0 px-2 text-[11px]"
            >
              {showCreate ? (
                <ChevronUp className="icon-xs mr-1" />
              ) : (
                <Plus className="icon-xs mr-1" />
              )}
              {showCreate ? t('worktreeSettings.cancel') : t('worktreeSettings.createWorktree')}
            </Button>
          )}
        </div>

        <ScrollArea className="min-h-0 flex-1" viewportProps={{ className: '[&>div]:h-full' }}>
          <div className="flex min-h-full flex-col">
            {/* Create form */}
            {!readOnly && showCreate && (
              <WorktreeCreateForm
                branches={branches}
                branchName={branchName}
                baseBranch={baseBranch}
                creating={creating}
                onBranchNameChange={setBranchName}
                onBaseBranchChange={setBaseBranch}
                onCreate={handleCreate}
              />
            )}

            {loading ? (
              <LoadingState
                testId="worktree-settings-loading"
                label={t('worktreeSettings.loadingWorktrees')}
              />
            ) : worktrees.length === 0 ? (
              <EmptyState
                icon={GitFork}
                title={t('worktreeSettings.noWorktrees')}
                className="flex-1"
                testId="worktree-settings-empty"
              />
            ) : (
              <div className="divide-sidebar-border flex flex-col divide-y">
                {worktrees.map((wt) => (
                  <WorktreeCard
                    key={wt.path}
                    worktree={wt}
                    active={!!activePath && wt.path === activePath}
                    readOnly={readOnly}
                    onRemove={() => setConfirmRemove(wt)}
                    removing={removingPath === wt.path}
                  />
                ))}
              </div>
            )}
          </div>
        </ScrollArea>
      </div>

      {/* Confirm remove dialog */}
      <ConfirmDialog
        open={!!confirmRemove}
        onOpenChange={(open) => {
          if (!open) setConfirmRemove(null);
        }}
        title={t('dialog.deleteWorktree')}
        description={t('dialog.deleteWorktreeDesc', { branch: confirmRemove?.branch })}
        cancelLabel={t('common.cancel')}
        confirmLabel={t('common.delete')}
        onCancel={() => setConfirmRemove(null)}
        onConfirm={handleRemoveConfirmed}
      />
    </div>
  );
}
