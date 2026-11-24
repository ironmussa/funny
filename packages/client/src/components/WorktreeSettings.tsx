import type { Thread, ThreadStatus } from '@funny/shared';
import {
  Trash2,
  Plus,
  Loader2,
  AlertCircle,
  GitBranch,
  GitFork,
  House,
  ExternalLink,
  ChevronUp,
  RefreshCw,
} from 'lucide-react';
import { useEffect, useState, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { ConfirmDialog } from '@/components/ConfirmDialog';
import { ToolbarCount } from '@/components/review-pane/ToolbarCount';
import { ThreadItem } from '@/components/sidebar/ThreadItem';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { LoadingState } from '@/components/ui/loading-state';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useGitStatusForThread } from '@/data/git-status/hooks';
import { useProjects } from '@/data/projects/hooks';
import { useStableNavigate } from '@/hooks/use-stable-navigate';
import { api } from '@/lib/api';
import {
  listRowActionBusyClassName,
  listRowActionClassName,
  listRowDestructiveActionClassName,
  listRowClassName,
} from '@/lib/list-row-styles';
import { useThreadsForProject } from '@/lib/thread-selectors';
import { toastError } from '@/lib/toast-error';
import { cn } from '@/lib/utils';
import { whilePending } from '@/lib/while-pending';
import { goToThread } from '@/navigation/go-to-thread';
import { buildThreadPath } from '@/navigation/thread-paths';
import { useProjectStore } from '@/stores/project-store';
import { useThreadStore } from '@/stores/thread-store';

import { BranchPicker } from './SearchablePicker';

interface WorktreeInfo {
  path: string;
  /** Absent for a worktree with a detached HEAD. */
  branch?: string;
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

/** A thread whose agent is working, or about to. */
const BUSY_STATUSES: ReadonlySet<ThreadStatus> = new Set([
  'setting_up',
  'pending',
  'running',
  'waiting',
]);

/** When a worktree's threads were last active (ISO), or '' when it has none. */
function lastActivity(threads: Thread[]): string {
  return threads.reduce((latest, thread) => {
    return thread.updatedAt > latest ? thread.updatedAt : latest;
  }, '');
}

/**
 * The order the list shows worktrees in: the main checkout, then those whose
 * agent is working, then the rest with threads by latest activity, then the
 * ones no thread works in. Stable within each rank.
 */
function orderWorktrees(
  worktrees: WorktreeInfo[],
  threadsByWorktree: Map<string, Thread[]>,
): WorktreeInfo[] {
  const rank = (wt: WorktreeInfo) => {
    if (wt.isMain) return 0;
    const threads = threadsByWorktree.get(wt.path) ?? [];
    if (threads.some((thread) => BUSY_STATUSES.has(thread.status))) return 1;
    return threads.length > 0 ? 2 : 3;
  };
  return worktrees
    .map((wt, index) => ({
      wt,
      index,
      rank: rank(wt),
      at: lastActivity(threadsByWorktree.get(wt.path) ?? []),
    }))
    .sort((a, b) => a.rank - b.rank || b.at.localeCompare(a.at) || a.index - b.index)
    .map(({ wt }) => wt);
}

/**
 * One thread working in a worktree, drawn as the left sidebar draws it
 * (`ThreadItem`: status, title, PR and git-state chips, branch powerline,
 * snippet and time), so the two lists read the same. The worktree row keeps
 * its own actions, so the thread's menu is hidden.
 */
function WorktreeThreadItem({ thread, projectPath }: { thread: Thread; projectPath: string }) {
  const navigate = useStableNavigate();
  const gitStatus = useGitStatusForThread(thread.id);
  const isSelected = useThreadStore((s) => s.selectedThreadId === thread.id);
  const onSelect = useCallback(() => goToThread(navigate, thread), [navigate, thread]);
  return (
    <ThreadItem
      thread={thread}
      projectPath={projectPath}
      isSelected={isSelected}
      onSelect={onSelect}
      gitStatus={gitStatus}
      href={buildThreadPath(thread)}
      hideActions
    />
  );
}

/**
 * The glyph a row without a thread shows in the column where a thread row
 * shows its status, so every row's text starts at the same place: a house for
 * the repository's original checkout, a branch for a worktree no thread works
 * in (one made outside funny, or whose thread was deleted).
 */
function WorktreeRowGlyph({ isMain }: { isMain: boolean }) {
  const { t } = useTranslation();
  const GlyphIcon = isMain ? House : GitBranch;
  return (
    <span className="flex size-3.5 shrink-0 items-center justify-center">
      <GlyphIcon
        className="icon-xs text-muted-foreground"
        role="img"
        aria-label={isMain ? t('worktreeSettings.main') : t('worktreeSettings.noThread')}
        data-testid={isMain ? 'worktree-main-icon' : 'worktree-no-thread-icon'}
      />
    </span>
  );
}

/** What names a worktree: its branch, or its short commit when HEAD is detached. */
function worktreeLabel(worktree: WorktreeInfo): string;
function worktreeLabel(worktree: WorktreeInfo | null): string | undefined;
function worktreeLabel(worktree: WorktreeInfo | null): string | undefined {
  if (!worktree) return undefined;
  return worktree.branch ?? worktree.commit.slice(0, 7);
}

/**
 * The name of a worktree no thread works in: its branch, or "detached at
 * <commit>" when it has none. A worktree with threads is named by their rows.
 */
function WorktreeBranchLabel({ worktree }: { worktree: WorktreeInfo }) {
  const { t } = useTranslation();
  const className = 'text-foreground min-w-0 truncate font-mono text-xs leading-5';
  if (worktree.branch) {
    return (
      <span
        className={className}
        title={worktree.branch}
        data-testid={`worktree-branch-${worktree.branch}`}
      >
        {worktree.branch}
      </span>
    );
  }
  const shortCommit = worktreeLabel(worktree);
  return (
    <span
      className={className}
      title={worktree.commit}
      data-testid={`worktree-detached-${shortCommit}`}
    >
      {t('worktreeSettings.detached', { commit: shortCommit })}
    </span>
  );
}

function WorktreeCard({
  worktree,
  threads,
  projectPath,
  onRemove,
  removing,
  active,
  readOnly,
}: {
  worktree: WorktreeInfo;
  threads: Thread[];
  projectPath: string;
  onRemove: () => void;
  removing: boolean;
  active: boolean;
  readOnly: boolean;
}) {
  const { t } = useTranslation();
  const rowKey = worktreeLabel(worktree);
  const hasThreads = threads.length > 0;
  return (
    <div
      // oxlint-disable-next-line shadcn/require-static-classes -- listRowClassName is a static constant from list-row-styles
      className={cn(
        listRowClassName,
        // Thread rows bring the sidebar's own padding; a worktree with no thread is one line.
        hasThreads ? 'px-1 py-1' : 'items-center py-1.5',
        active && 'bg-sidebar-selected hover:bg-sidebar-selected',
      )}
      aria-current={active || undefined}
      data-active={active || undefined}
      data-testid={`worktree-row-${rowKey}`}
    >
      {hasThreads ? (
        // The thread is what a worktree is for: its sidebar row, branch included, names it.
        <div
          className="flex min-w-0 flex-1 flex-col"
          data-testid="worktree-threads"
          title={worktree.path}
        >
          {threads.map((thread) => (
            <WorktreeThreadItem key={thread.id} thread={thread} projectPath={projectPath} />
          ))}
        </div>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-1.5" title={worktree.path}>
          <WorktreeRowGlyph isMain={worktree.isMain} />
          <WorktreeBranchLabel worktree={worktree} />
          {!worktree.isMain && (
            <span className="text-muted-foreground text-2xs shrink-0">
              {t('worktreeSettings.noThread')}
            </span>
          )}
        </div>
      )}
      {!readOnly && (
        <ButtonGroup data-testid={`worktree-actions-${rowKey}`}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={t('sidebar.openDirectory')}
                onClick={async () => {
                  const result = await api.openDirectory({ path: worktree.path });
                  if (result.isErr()) toastError(result.error);
                }}
                // oxlint-disable-next-line shadcn/require-static-classes -- listRowActionClassName is a static constant from list-row-styles
                className={listRowActionClassName}
                data-testid={`worktree-open-directory-${rowKey}`}
              >
                <ExternalLink className="icon-sm" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" variant="mono">
              {worktree.path}
              {worktree.isMain && (
                <span className="text-muted-foreground block font-sans">
                  {t('worktreeSettings.mainDescription')}
                </span>
              )}
            </TooltipContent>
          </Tooltip>
          {!worktree.isMain && (
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
                    listRowDestructiveActionClassName,
                    removing && listRowActionBusyClassName,
                  )}
                  // oxlint-enable shadcn/require-static-classes
                  data-testid={`worktree-delete-${rowKey}`}
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
        </ButtonGroup>
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
          mono
          size="xs"
          id="worktree-branch-name"
          type="text"
          value={branchName}
          onChange={(e) => onBranchNameChange(e.target.value)}
          placeholder="feature/my-new-branch"
          className="h-8"
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

/** A failed create, shown under the create form. */
function CreateError({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  const { t } = useTranslation();
  return (
    <div
      className="text-destructive flex items-center gap-2 px-3 pb-2 text-xs"
      data-testid="worktree-settings-create-error"
    >
      <AlertCircle className="icon-sm shrink-0" />
      <span className="min-w-0 flex-1">{message}</span>
      <button
        type="button"
        onClick={onDismiss}
        className="shrink-0 underline"
        data-testid="worktree-settings-create-error-dismiss"
      >
        {t('worktreeSettings.dismiss')}
      </button>
    </div>
  );
}

/**
 * What the list shows while it has no worktrees: loading, a failed load in
 * place of the list, or that there are none. A refresh keeps a loaded list on
 * screen; the button's icon shows it is loading.
 */
function EmptyWorktreeList({ loading, loadError }: { loading: boolean; loadError: string | null }) {
  const { t } = useTranslation();
  if (loading) {
    return (
      <LoadingState
        testId="worktree-settings-loading"
        label={t('worktreeSettings.loadingWorktrees')}
      />
    );
  }
  if (loadError) {
    return (
      <EmptyState
        icon={GitFork}
        title={t('worktreeSettings.loadFailed', 'Could not load worktrees')}
        description={loadError}
        className="flex-1"
        testId="worktree-settings-load-error"
      />
    );
  }
  return (
    <EmptyState
      icon={GitFork}
      title={t('worktreeSettings.noWorktrees')}
      className="flex-1"
      testId="worktree-settings-empty"
    />
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
  const orderedWorktrees = useMemo(
    () => orderWorktrees(worktrees, threadsByWorktree),
    [worktrees, threadsByWorktree],
  );

  // The project object is derived on every render; its id is what the loaders follow.
  const activeProjectId = project?.id;
  const loadWorktrees = useCallback(async () => {
    if (activeProjectId === undefined) return;
    setLoadError(null);
    await whilePending(setLoading, async () => {
      const result = await api.listWorktrees(activeProjectId);
      if (result.isOk()) setWorktrees(result.value);
      else setLoadError(result.error.message);
    });
  }, [activeProjectId]);

  const loadBranches = useCallback(async () => {
    if (activeProjectId === undefined) return;
    const result = await api.listBranches(activeProjectId);
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
  }, [activeProjectId]);

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
                variant="muted"
                size="icon-sm"
                onClick={handleRefresh}
                disabled={loading}
                aria-label={t('worktreeSettings.refresh')}
                className="shrink-0"
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
                  variant="muted"
                  size="icon-sm"
                  onClick={() => setShowCreate(!showCreate)}
                  aria-label={createLabel}
                  aria-expanded={showCreate}
                  className="shrink-0"
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
              <CreateError message={error} onDismiss={() => setError(null)} />
            )}

            {worktrees.length === 0 ? (
              <EmptyWorktreeList loading={loading} loadError={loadError} />
            ) : (
              <div className="divide-sidebar-border flex flex-col divide-y">
                {orderedWorktrees.map((wt) => (
                  <WorktreeCard
                    key={wt.path}
                    worktree={wt}
                    threads={threadsByWorktree.get(wt.path) ?? []}
                    projectPath={project.path}
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
        description={t('dialog.deleteWorktreeDesc', {
          branch: worktreeLabel(confirmRemove),
        })}
        cancelLabel={t('common.cancel')}
        confirmLabel={t('common.delete')}
        onCancel={() => setConfirmRemove(null)}
        onConfirm={handleRemoveConfirmed}
      />
    </div>
  );
}
