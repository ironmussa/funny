import { Trash2, Plus, Loader2, AlertCircle, GitFork, FolderOpen, ChevronUp } from 'lucide-react';
import { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { LoadingState } from '@/components/ui/loading-state';
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
}: {
  worktree: WorktreeInfo;
  onRemove: () => void;
  removing: boolean;
}) {
  return (
    <div className="border-border/50 bg-card flex items-center justify-between gap-3 rounded-md border px-3 py-2.5">
      <div className="flex min-w-0 items-center gap-3">
        <GitFork className="icon-base text-status-info shrink-0" />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{worktree.branch}</span>
          </div>
          <div className="mt-0.5 flex items-center gap-2">
            <FolderOpen className="icon-xs text-muted-foreground/70 shrink-0" />
            <span className="text-muted-foreground/70 truncate font-mono text-xs">
              {worktree.path}
            </span>
          </div>
          {worktree.commit && (
            <span className="text-muted-foreground/70 font-mono text-xs">
              {worktree.commit.slice(0, 8)}
            </span>
          )}
        </div>
      </div>
      {!worktree.isMain && (
        <Button
          variant="ghost"
          size="icon-xs"
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

export function WorktreeSettings() {
  const { t } = useTranslation();
  const projects = useAppStore((s) => s.projects);
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

  const project = selectedProjectId
    ? projects.find((p) => p.id === selectedProjectId)
    : projects[0];

  const loadWorktrees = useCallback(async () => {
    if (!project) return;
    setLoading(true);
    setError(null);
    const result = await api.listWorktrees(project.id);
    if (result.isOk()) {
      setWorktrees(result.value);
    } else {
      setError(result.error.message);
    }
    setLoading(false);
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
    if (!branchName.trim() || !project) return;
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
    if (!project || !confirmRemove) return;
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
    return (
      <div className="text-muted-foreground py-6 text-center text-sm">
        {t('worktreeSettings.noProject')}
      </div>
    );
  }

  return (
    <div className="space-y-6">
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
      <div>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-muted-foreground text-xs font-semibold tracking-wider uppercase">
            {t('worktreeSettings.worktrees')}
          </h3>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowCreate(!showCreate)}
            className="px-2"
          >
            {showCreate ? (
              <ChevronUp className="icon-xs mr-1" />
            ) : (
              <Plus className="icon-xs mr-1" />
            )}
            {showCreate ? t('worktreeSettings.cancel') : t('worktreeSettings.createWorktree')}
          </Button>
        </div>

        {/* Create form */}
        {showCreate &&
          (branches.length === 0 ? (
            <div className="bg-status-pending/10 text-status-pending/80 mb-3 flex items-center gap-2 rounded-md px-3 py-2 text-xs">
              <AlertCircle className="icon-sm shrink-0" />
              <span>No branches found. Make sure the project has at least one commit.</span>
            </div>
          ) : (
            <div className="border-border/50 bg-muted/30 mb-3 space-y-3 rounded-lg border p-3">
              <div>
                <label className="text-muted-foreground mb-1 block text-xs">
                  {t('worktreeSettings.branchName')}
                </label>
                <Input
                  type="text"
                  value={branchName}
                  onChange={(e) => setBranchName(e.target.value)}
                  placeholder="feature/my-new-branch"
                  className="h-8 px-2 font-mono text-xs"
                  onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
                />
              </div>

              <div>
                <label className="text-muted-foreground mb-1 block text-xs">
                  {t('worktreeSettings.baseBranch')}
                </label>
                <BranchPicker
                  branches={branches}
                  selected={baseBranch}
                  onChange={setBaseBranch}
                  triggerClassName="flex h-8 w-full items-center gap-2 rounded-md border border-input bg-background px-3 text-xs transition-colors hover:bg-accent/50 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring/50"
                  side="bottom"
                  align="start"
                  showCopy={false}
                  placeholder="main (default)"
                />
              </div>

              <Button
                size="sm"
                onClick={handleCreate}
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
          ))}

        {loading ? (
          <LoadingState
            fill={false}
            layout="inline"
            className="py-6"
            testId="worktree-settings-loading"
            label={t('worktreeSettings.loadingWorktrees')}
          />
        ) : worktrees.length === 0 ? (
          <div className="text-muted-foreground py-6 text-center text-sm">
            {t('worktreeSettings.noWorktrees')}
          </div>
        ) : (
          <div className="space-y-1.5">
            {worktrees.map((wt) => (
              <WorktreeCard
                key={wt.path}
                worktree={wt}
                onRemove={() => setConfirmRemove(wt)}
                removing={removingPath === wt.path}
              />
            ))}
          </div>
        )}
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
