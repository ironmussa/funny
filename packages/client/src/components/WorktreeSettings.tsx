import { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useAppStore } from '@/stores/app-store';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Trash2,
  Plus,
  Loader2,
  AlertCircle,
  GitFork,
  GitBranch,
  FolderOpen,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';

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
    <div className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-md border border-border/50 bg-card">
      <div className="flex items-center gap-3 min-w-0">
        <GitFork className="h-4 w-4 text-blue-500 flex-shrink-0" />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium truncate">{worktree.branch}</span>
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            <FolderOpen className="h-3 w-3 text-muted-foreground/70 flex-shrink-0" />
            <span className="text-xs text-muted-foreground/70 truncate font-mono">
              {worktree.path}
            </span>
          </div>
          {worktree.commit && (
            <span className="text-xs text-muted-foreground/70 font-mono">
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
          className="text-muted-foreground hover:text-destructive flex-shrink-0"
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
  const projects = useAppStore(s => s.projects);
  const selectedProjectId = useAppStore(s => s.selectedProjectId);
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
        <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-destructive/10 text-destructive text-xs">
          <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" />
          <span>{error}</span>
          <button onClick={() => setError(null)} className="ml-auto text-xs underline">
            {t('worktreeSettings.dismiss')}
          </button>
        </div>
      )}

      {/* Worktree list */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            {t('worktreeSettings.worktrees')}
          </h3>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowCreate(!showCreate)}
            className="text-xs h-6 px-2"
          >
            {showCreate ? (
              <ChevronUp className="h-3 w-3 mr-1" />
            ) : (
              <Plus className="h-3 w-3 mr-1" />
            )}
            {showCreate ? t('worktreeSettings.cancel') : t('worktreeSettings.createWorktree')}
          </Button>
        </div>

        {/* Create form */}
        {showCreate && (
          branches.length === 0 ? (
            <div className="flex items-center gap-2 px-3 py-2 mb-3 rounded-md bg-yellow-500/10 text-yellow-600 dark:text-yellow-400 text-xs">
              <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" />
              <span>No branches found. Make sure the project has at least one commit.</span>
            </div>
          ) : (
            <div className="rounded-lg border border-border/50 p-3 mb-3 space-y-3 bg-muted/30">
              <div>
                <label className="text-xs text-muted-foreground block mb-1">
                  {t('worktreeSettings.branchName')}
                </label>
                <input
                  type="text"
                  value={branchName}
                  onChange={(e) => setBranchName(e.target.value)}
                  placeholder="feature/my-new-branch"
                  className="w-full h-8 px-2 text-sm rounded-md border border-border bg-background focus:outline-none focus:ring-1 focus:ring-ring font-mono text-xs"
                  onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
                />
              </div>

              <div>
                <label className="text-xs text-muted-foreground block mb-1">
                  {t('worktreeSettings.baseBranch')}
                </label>
                <Select value={baseBranch} onValueChange={setBaseBranch}>
                  <SelectTrigger className="w-full h-8 text-xs">
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
                className="text-xs h-8 w-full"
              >
                {creating ? (
                  <Loader2 className="h-3 w-3 animate-spin mr-1" />
                ) : (
                  <Plus className="h-3 w-3 mr-1" />
                )}
                {creating ? t('worktreeSettings.creating') : t('worktreeSettings.createWorktree')}
              </Button>
            </div>
          )
        )}

        {loading ? (
          <div className="flex items-center gap-2 py-6 justify-center text-sm text-muted-foreground">
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
      <Dialog open={!!confirmRemove} onOpenChange={(open) => { if (!open) setConfirmRemove(null); }}>
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
