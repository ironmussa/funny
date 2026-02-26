import {
  Trash2,
  Plus,
  Loader2,
  AlertCircle,
  GitFork,
  GitBranch,
  FolderOpen,
  ChevronUp,
} from 'lucide-react';
import { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { api } from '@/lib/api';
import { useAppStore } from '@/stores/app-store';

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
    <div className="flex items-center justify-between gap-3 rounded-md border border-border/50 bg-card px-3 py-2.5">
      <div className="flex min-w-0 items-center gap-3">
        <GitFork className="h-4 w-4 flex-shrink-0 text-status-info" />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{worktree.branch}</span>
          </div>
          <div className="mt-0.5 flex items-center gap-2">
            <FolderOpen className="h-3 w-3 flex-shrink-0 text-muted-foreground/70" />
            <span className="truncate font-mono text-xs text-muted-foreground/70">
              {worktree.path}
            </span>
          </div>
          {worktree.commit && (
            <span className="font-mono text-xs text-muted-foreground/70">
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
          className="flex-shrink-0 text-muted-foreground hover:text-destructive"
        >
          {removing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Trash2 className="h-3.5 w-3.5" />
          )}
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
      <div className="py-6 text-center text-sm text-muted-foreground">
        {t('worktreeSettings.noProject')}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Project indicator */}
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <GitFork className="h-3.5 w-3.5" />
        <span>
          {t('worktreeSettings.worktreesFor')}{' '}
          <span className="font-medium text-foreground">{project.name}</span>
        </span>
      </div>

      {/* Error banner */}
      {error && (
        <div className="flex items-center gap-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" />
          <span>{error}</span>
          <button onClick={() => setError(null)} className="ml-auto text-xs underline">
            {t('worktreeSettings.dismiss')}
          </button>
        </div>
      )}

      {/* Worktree list */}
      <div>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {t('worktreeSettings.worktrees')}
          </h3>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowCreate(!showCreate)}
            className="h-6 px-2 text-xs"
          >
            {showCreate ? (
              <ChevronUp className="mr-1 h-3 w-3" />
            ) : (
              <Plus className="mr-1 h-3 w-3" />
            )}
            {showCreate ? t('worktreeSettings.cancel') : t('worktreeSettings.createWorktree')}
          </Button>
        </div>

        {/* Create form */}
        {showCreate &&
          (branches.length === 0 ? (
            <div className="mb-3 flex items-center gap-2 rounded-md bg-status-pending/10 px-3 py-2 text-xs text-status-pending/80">
              <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" />
              <span>No branches found. Make sure the project has at least one commit.</span>
            </div>
          ) : (
            <div className="mb-3 space-y-3 rounded-lg border border-border/50 bg-muted/30 p-3">
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">
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
                <label className="mb-1 block text-xs text-muted-foreground">
                  {t('worktreeSettings.baseBranch')}
                </label>
                <Select value={baseBranch} onValueChange={setBaseBranch}>
                  <SelectTrigger className="h-8 w-full text-xs">
                    <SelectValue placeholder="main (default)" />
                  </SelectTrigger>
                  <SelectContent>
                    {branches.map((b) => (
                      <SelectItem key={b} value={b}>
                        <div className="flex items-center gap-1.5">
                          <GitBranch className="h-3 w-3" />
                          {b}
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <Button
                size="sm"
                onClick={handleCreate}
                disabled={!branchName.trim() || creating}
                className="h-8 w-full text-xs"
              >
                {creating ? (
                  <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                ) : (
                  <Plus className="mr-1 h-3 w-3" />
                )}
                {creating ? t('worktreeSettings.creating') : t('worktreeSettings.createWorktree')}
              </Button>
            </div>
          ))}

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('worktreeSettings.loadingWorktrees')}
          </div>
        ) : worktrees.length === 0 ? (
          <div className="py-6 text-center text-sm text-muted-foreground">
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
      <Dialog
        open={!!confirmRemove}
        onOpenChange={(open) => {
          if (!open) setConfirmRemove(null);
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('dialog.deleteWorktree')}</DialogTitle>
            <DialogDescription>
              {t('dialog.deleteWorktreeDesc', { branch: confirmRemove?.branch })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setConfirmRemove(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant="destructive" size="sm" onClick={handleRemoveConfirmed}>
              {t('common.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
