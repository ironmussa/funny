import type { Thread } from '@funny/shared';
import {
  Trash2,
  Plus,
  Loader2,
  AlertCircle,
  GitFork,
  FolderOpen,
  ChevronUp,
  GitCommitHorizontal,
  MessageSquare,
  RefreshCw,
} from 'lucide-react';
import { useEffect, useState, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { BranchBadge } from '@/components/BranchBadge';
import { CommitHash } from '@/components/CommitHash';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { ToolbarCount } from '@/components/review-pane/ToolbarCount';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { LabelBadge } from '@/components/ui/label-badge';
import { LoadingState } from '@/components/ui/loading-state';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useProjects } from '@/data/projects/hooks';
import { useStableNavigate } from '@/hooks/use-stable-navigate';
import { api } from '@/lib/api';
import {
  listRowActionBusyClassName,
  listRowActionClassName,
  listRowClassName,
  listRowTitleClassName,
} from '@/lib/list-row-styles';
import { useThreadsForProject } from '@/lib/thread-selectors';
import { getThreadRoute } from '@/lib/thread-variant';
import { toastError } from '@/lib/toast-error';
import { buildPath } from '@/lib/url';
import { cn } from '@/lib/utils';
import { useProjectStore } from '@/stores/project-store';

import { BranchPicker } from './SearchablePicker';

interface WorktreeInfo {
  path: string;
  branch: string;
  commit: string;
  isMain: boolean;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * Threads working in each worktree, keyed by worktree path. A thread matches
 * by its recorded worktree path; a linked (non-main) worktree also claims a
 * worktree-mode thread on its branch whose path was not recorded.
 */
export function groupThreadsByWorktree(
  worktrees: WorktreeInfo[],
  threads: Thread[],
): Map<string, Thread[]> {
  const byPath = new Map<string, Thread[]>();
  const pathKeys = new Map(worktrees.map((wt) => [normalizePath(wt.path), wt.path]));
  const linkedByBranch = new Map(
    worktrees.flatMap((wt): [string, string][] =>
      !wt.isMain && wt.branch ? [[wt.branch, wt.path]] : [],
    ),
  );
  for (const thread of threads) {
    if (thread.archived) continue;
    const key = thread.worktreePath
      ? pathKeys.get(normalizePath(thread.worktreePath))
      : thread.mode === 'worktree' && thread.branch
        ? linkedByBranch.get(thread.branch)
        : undefined;
    if (!key) continue;
    const list = byPath.get(key);
    if (list) list.push(thread);
    else byPath.set(key, [thread]);
  }
  return byPath;
}

function WorktreeThreadLinks({ threads }: { threads: Thread[] }) {
  const { t } = useTranslation();
  const navigate = useStableNavigate();
  return (
    <div className="flex min-w-0 flex-col gap-0.5" data-testid="worktree-threads">
      {threads.map((thread) => {
        const href = buildPath(getThreadRoute(thread));
        return (
          <a
            key={thread.id}
            href={href}
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
              e.preventDefault();
              navigate(href);
            }}
            title={t('worktreeSettings.openThread', { title: thread.title })}
            className="text-muted-foreground hover:text-foreground flex min-w-0 items-center gap-1.5 text-xs hover:underline"
            data-testid={`worktree-thread-link-${thread.id}`}
          >
            <MessageSquare className="icon-xs shrink-0" />
            <span className="truncate">{thread.title}</span>
          </a>
        );
      })}
    </div>
  );
}

function WorktreeCard({
  worktree,
  threads,
  onRemove,
  removing,
  active,
  readOnly,
}: {
  worktree: WorktreeInfo;
  threads: Thread[];
  onRemove: () => void;
  removing: boolean;
  active: boolean;
  readOnly: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className={listRowClassName}>
      <div className="flex min-w-0 flex-1 items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <BranchBadge
              branch={worktree.branch}
              variant="plain"
              className={cn(listRowTitleClassName, 'font-mono')}
              data-testid={`worktree-branch-${worktree.branch}`}
            />
            {worktree.isMain && (
              <LabelBadge
                tone="info"
                title={t('worktreeSettings.mainDescription')}
                data-testid="worktree-badge-main"
              >
                {t('worktreeSettings.main')}
              </LabelBadge>
            )}
            {active && (
              <LabelBadge
                tone="success"
                title={t('worktreeSettings.activeDescription')}
                data-testid="worktree-badge-active"
              >
                {t('worktreeSettings.active')}
              </LabelBadge>
            )}
          </div>
          {readOnly ? (
            <div className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs">
              <FolderOpen className="icon-xs shrink-0 opacity-70" />
              <span title={worktree.path} className="truncate font-mono">
                {worktree.path}
              </span>
            </div>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={async () => {
                    const result = await api.openDirectory({ path: worktree.path });
                    if (result.isErr()) toastError(result.error);
                  }}
                  className="text-muted-foreground hover:text-foreground flex min-w-0 cursor-pointer items-center gap-1.5 text-left text-xs transition-colors"
                  data-testid={`worktree-open-directory-${worktree.branch}`}
                >
                  <FolderOpen className="icon-xs shrink-0 opacity-70" />
                  <span className="truncate font-mono hover:underline">{worktree.path}</span>
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" variant="mono">
                {worktree.path}
              </TooltipContent>
            </Tooltip>
          )}
          {worktree.commit && (
            <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
              <GitCommitHorizontal className="icon-xs shrink-0" />
              <CommitHash hash={worktree.commit} />
            </span>
          )}
          {threads.length > 0 && <WorktreeThreadLinks threads={threads} />}
        </div>
      </div>
      {!readOnly && !worktree.isMain && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={t('dialog.deleteWorktree')}
              onClick={onRemove}
              disabled={removing}
              // oxlint-disable shadcn/require-static-classes -- listRowActionClassName and listRowActionBusyClassName are static constants from list-row-styles
              className={cn(
                listRowActionClassName,
                'hover:text-destructive',
                removing && listRowActionBusyClassName,
              )}
              // oxlint-enable shadcn/require-static-classes
              data-testid={`worktree-delete-${worktree.branch}`}
            >
              {removing ? (
                <Loader2 className="icon-sm animate-spin" />
              ) : (
                <Trash2 className="icon-sm" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left">{t('dialog.deleteWorktree')}</TooltipContent>
        </Tooltip>
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
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId);
  const [worktrees, setWorktrees] = useState<WorktreeInfo[]>([]);
  const [branches, setBranches] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  /** The worktree list could not be read (e.g. the runner is offline). */
  const [loadError, setLoadError] = useState<string | null>(null);
  /** Creating a worktree failed; shown under the create form. */
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
  const projectThreads = useThreadsForProject(project?.id ?? '');
  const threadsByWorktree = useMemo(
    () => groupThreadsByWorktree(worktrees, projectThreads),
    [worktrees, projectThreads],
  );

  const loadWorktrees = useCallback(async () => {
    if (!project) return;
    setLoading(true);
    setLoadError(null);
    try {
      const result = await api.listWorktrees(project.id);
      if (result.isOk()) setWorktrees(result.value);
      else setLoadError(result.error.message);
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
      // Only the create form uses the branches; the list's own load error
      // already says when the runner cannot be reached.
      console.error('Failed to load branches:', result.error);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-run when project.id changes; project object is derived each render
  }, [project?.id]);

  useEffect(() => {
    loadWorktrees();
    loadBranches();
  }, [loadWorktrees, loadBranches]);

  /** Re-read worktrees and branches, e.g. after one was added or removed outside funny. */
  const handleRefresh = () => {
    void loadWorktrees();
    void loadBranches();
  };

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

  const createLabel = showCreate
    ? t('worktreeSettings.cancel')
    : t('worktreeSettings.createWorktree');

  return (
    <div className="flex h-full min-h-0 w-full flex-col text-xs">
      {/* Worktree list */}
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="border-sidebar-border flex shrink-0 items-center gap-1 border-b px-2 py-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={handleRefresh}
                disabled={loading}
                aria-label={t('worktreeSettings.refresh')}
                className="text-muted-foreground shrink-0"
                data-testid="worktree-settings-refresh"
              >
                <RefreshCw className={cn('icon-base', loading && 'animate-spin')} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t('worktreeSettings.refresh')}</TooltipContent>
          </Tooltip>
          {!readOnly && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setShowCreate(!showCreate)}
                  aria-label={createLabel}
                  aria-expanded={showCreate}
                  className="text-muted-foreground shrink-0"
                  data-testid="worktree-settings-create"
                >
                  {showCreate ? (
                    <ChevronUp className="icon-base" />
                  ) : (
                    <Plus className="icon-base" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{createLabel}</TooltipContent>
            </Tooltip>
          )}
          <ToolbarCount
            label={t('review.toolbarCount.worktrees', { count: worktrees.length })}
            testId="worktree-settings-count"
          />
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
            {!readOnly && showCreate && error && (
              <div
                className="text-destructive flex items-center gap-2 px-3 pb-2 text-xs"
                data-testid="worktree-settings-create-error"
              >
                <AlertCircle className="icon-sm shrink-0" />
                <span className="min-w-0 flex-1">{error}</span>
                <button
                  type="button"
                  onClick={() => setError(null)}
                  className="shrink-0 underline"
                  data-testid="worktree-settings-create-error-dismiss"
                >
                  {t('worktreeSettings.dismiss')}
                </button>
              </div>
            )}

            {/* A refresh keeps the list on screen; the button's icon shows it is loading. */}
            {loading && worktrees.length === 0 ? (
              <LoadingState
                testId="worktree-settings-loading"
                label={t('worktreeSettings.loadingWorktrees')}
              />
            ) : worktrees.length === 0 && loadError ? (
              <EmptyState
                icon={GitFork}
                title={t('worktreeSettings.loadFailed', 'Could not load worktrees')}
                description={loadError}
                className="flex-1"
                testId="worktree-settings-load-error"
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
                    threads={threadsByWorktree.get(wt.path) ?? []}
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
