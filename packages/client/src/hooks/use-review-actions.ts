import type { FileDiffSummary } from '@funny/shared';
import { useCallback, useState, type Dispatch, type SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { isDivergedBranchesError } from '@/components/pull-strategy-dialog';
import { type PullStrategy } from '@/lib/api/_core';
import { browseApi } from '@/lib/api/browse';
import { gitApi } from '@/lib/api/git';
import { threadsApi } from '@/lib/api/threads';
import { createClientLogger } from '@/lib/client-logger';
import { toastError } from '@/lib/toast-error';
import { useGitStatusStore } from '@/stores/git-status-store';
import { deriveToolLists, useSettingsStore } from '@/stores/settings-store';
import { getThreadById } from '@/stores/thread-context';

const log = createClientLogger('review-actions');

interface ConfirmDialogValue {
  type: 'revert' | 'reset' | 'discard-all' | 'drop-stash' | 'ignore';
  path?: string;
  paths?: string[];
  stashIndex?: string;
}

interface UseReviewActionsArgs {
  hasGitContext: boolean;
  effectiveThreadId: string | undefined;
  projectModeId: string | null;
  summaries: FileDiffSummary[];
  checkedFiles: Set<string>;
  expandedFile: string | null;
  selectedFile: string | null;
  baseBranch: string | undefined;
  basePath: string | undefined;
  refresh: () => Promise<void> | void;
  loadDiffForFile: (path: string) => Promise<void>;
  setDiffCache: Dispatch<SetStateAction<Map<string, string>>>;
  setHasRebaseConflict: Dispatch<SetStateAction<boolean>>;
  setConfirmDialog: Dispatch<SetStateAction<ConfirmDialogValue | null>>;
  refreshStashList: () => Promise<void>;
}

export interface UseReviewActionsResult {
  // In-progress flags
  pullInProgress: boolean;
  fetchInProgress: boolean;
  stashInProgress: boolean;
  resetInProgress: boolean;
  patchStagingInProgress: boolean;

  // Pull strategy dialog (state owned here, JSX rendered by parent)
  pullStrategyDialog: { open: boolean; errorMessage: string };
  setPullStrategyDialog: Dispatch<SetStateAction<{ open: boolean; errorMessage: string }>>;

  // Per-file line-selection signals (consumed by ChangesFilesPanel + DiffViewerModal)
  fileSelectionState: Map<string, 'all' | 'partial' | 'none'>;
  setFileSelectionState: Dispatch<SetStateAction<Map<string, 'all' | 'partial' | 'none'>>>;
  selectAllSignal: number;
  setSelectAllSignal: Dispatch<SetStateAction<number>>;
  deselectAllSignal: number;
  setDeselectAllSignal: Dispatch<SetStateAction<number>>;

  // Per-file open dialogs (these set confirm dialog; execute* run after confirmation)
  handleRevertFile: (path: string) => void;
  executeRevert: (path: string) => Promise<void>;
  handleDiscardAll: () => void;
  executeDiscardAll: (paths: string[]) => Promise<void>;
  handleIgnoreFiles: () => void;
  executeIgnoreFiles: (paths: string[]) => Promise<void>;
  handleIgnore: (pattern: string) => Promise<void>;
  executeResetSoft: () => Promise<void>;

  // Staging
  handleStageFile: (path: string) => Promise<void>;
  handleUnstageFile: (path: string) => Promise<void>;
  handleStageSelected: () => Promise<void>;
  handleUnstageAll: () => Promise<void>;
  handleStagePatch: (patch: string) => Promise<void>;
  handleSelectionStateChange: (filePath: string, state: 'all' | 'partial' | 'none') => void;

  // Conflict resolution
  handleResolveConflict: (blockId: number, resolution: 'ours' | 'theirs' | 'both') => Promise<void>;
  handleAskAgentResolve: () => Promise<void>;
  handleOpenInEditorConflict: () => void;

  // Network
  handlePull: () => Promise<void>;
  handlePullStrategyChosen: (strategy: Exclude<PullStrategy, 'ff-only'>) => Promise<void>;
  handleFetchOrigin: () => Promise<void>;

  // Stash creation (popping/dropping is in useStashState)
  handleStash: () => Promise<void>;
  handleStashSelected: () => Promise<void>;

  // Filesystem
  handleCopyPath: (path: string, relative: boolean) => void;
  handleOpenDirectory: (relativePath: string, isFile: boolean) => Promise<void>;
}

/**
 * Mega-hook bundling every action handler in ReviewPane that mutates git
 * state, calls the API, or opens the OS editor: stage / unstage / revert /
 * discard / ignore / pull / fetch / stash-create / reset-soft / conflict
 * resolve / agent-ask / copy-path / open-directory.
 *
 * The handlers share so much (api + toast + toastError + refresh callback)
 * that bundling them removes ~6 imports from ReviewPane and condenses ~400
 * lines of repetitive try/catch/toast scaffolding into a single module.
 *
 * Final piece of the ReviewPane god-file split — see
 * .claude/plans/reviewpane-split.md.
 */
export function useReviewActions({
  hasGitContext,
  effectiveThreadId,
  projectModeId,
  summaries,
  checkedFiles,
  expandedFile,
  selectedFile,
  baseBranch,
  basePath,
  refresh,
  loadDiffForFile,
  setDiffCache,
  setHasRebaseConflict,
  setConfirmDialog,
  refreshStashList,
}: UseReviewActionsArgs): UseReviewActionsResult {
  const { t } = useTranslation();

  // In-progress flags
  const [pullInProgress, setPullInProgress] = useState(false);
  const [pullStrategyDialog, setPullStrategyDialog] = useState<{
    open: boolean;
    errorMessage: string;
  }>({ open: false, errorMessage: '' });
  const [fetchInProgress, setFetchInProgress] = useState(false);
  const [stashInProgress, setStashInProgress] = useState(false);
  const [resetInProgress, setResetInProgress] = useState(false);
  const [patchStagingInProgress, setPatchStagingInProgress] = useState(false);

  // Per-file line-selection state for the indeterminate checkbox in ChangesFilesPanel
  const [fileSelectionState, setFileSelectionState] = useState<
    Map<string, 'all' | 'partial' | 'none'>
  >(new Map());
  // Increment to signal ExpandedDiffView to re-select all lines
  const [selectAllSignal, setSelectAllSignal] = useState(0);
  // Increment to signal ExpandedDiffView to deselect all lines
  const [deselectAllSignal, setDeselectAllSignal] = useState(0);

  // ── Discard / revert / ignore (open confirm dialog; execute after) ──

  const handleRevertFile = useCallback(
    (path: string) => setConfirmDialog({ type: 'revert', path }),
    [setConfirmDialog],
  );

  const executeRevert = useCallback(
    async (path: string) => {
      if (!hasGitContext) return;
      const result = effectiveThreadId
        ? await gitApi.revertFiles(effectiveThreadId, [path])
        : await gitApi.projectRevertFiles(projectModeId!, [path]);
      if (result.isErr()) {
        toast.error(t('review.revertFailed', { message: result.error.message }));
      } else {
        toast.success(t('review.revertSuccess', { path, defaultValue: '{{path}} reverted' }));
        await refresh();
      }
    },
    [hasGitContext, effectiveThreadId, projectModeId, refresh, t],
  );

  const handleDiscardAll = useCallback(() => {
    const paths = checkedFiles.size > 0 ? Array.from(checkedFiles) : summaries.map((s) => s.path);
    if (paths.length === 0) return;
    setConfirmDialog({ type: 'discard-all', paths });
  }, [checkedFiles, summaries, setConfirmDialog]);

  const executeDiscardAll = useCallback(
    async (paths: string[]) => {
      if (!hasGitContext) return;
      const result = effectiveThreadId
        ? await gitApi.revertFiles(effectiveThreadId, paths)
        : await gitApi.projectRevertFiles(projectModeId!, paths);
      if (result.isErr()) {
        toast.error(t('review.revertFailed', { message: result.error.message }));
      } else {
        toast.success(
          t('review.discardSuccess', {
            count: paths.length,
            defaultValue: '{{count}} file(s) discarded',
          }),
        );
        await refresh();
      }
    },
    [hasGitContext, effectiveThreadId, projectModeId, refresh, t],
  );

  const handleIgnoreFiles = useCallback(() => {
    const paths = checkedFiles.size > 0 ? Array.from(checkedFiles) : summaries.map((s) => s.path);
    if (paths.length === 0) return;
    setConfirmDialog({ type: 'ignore', paths });
  }, [checkedFiles, summaries, setConfirmDialog]);

  const executeIgnoreFiles = useCallback(
    async (paths: string[]) => {
      if (!hasGitContext) return;
      const result = effectiveThreadId
        ? await gitApi.addPatternsToGitignore(effectiveThreadId, paths)
        : await gitApi.projectAddPatternsToGitignore(projectModeId!, paths);
      if (result.isErr()) {
        toast.error(`Failed to update .gitignore: ${result.error.message}`);
      } else {
        toast.success(`${paths.length} path(s) added to .gitignore`);
        await refresh();
      }
    },
    [hasGitContext, effectiveThreadId, projectModeId, refresh],
  );

  const handleIgnore = useCallback(
    async (pattern: string) => {
      if (!hasGitContext) return;
      const result = effectiveThreadId
        ? await gitApi.addToGitignore(effectiveThreadId, pattern)
        : await gitApi.projectAddToGitignore(projectModeId!, pattern);
      if (result.isErr()) {
        toast.error(t('review.ignoreFailed', { message: result.error.message }));
      } else {
        toast.success(t('review.ignoreSuccess'));
        await refresh();
      }
    },
    [hasGitContext, effectiveThreadId, projectModeId, refresh, t],
  );

  const executeResetSoft = useCallback(async () => {
    if (!hasGitContext || resetInProgress) return;
    setResetInProgress(true);
    const result = effectiveThreadId
      ? await gitApi.resetSoft(effectiveThreadId)
      : await gitApi.projectResetSoft(projectModeId!);
    if (result.isErr()) {
      toast.error(
        t('review.resetSoftFailed', {
          message: result.error.message,
          defaultValue: `Reset failed: ${result.error.message}`,
        }),
      );
    } else {
      toast.success(t('review.resetSoftSuccess', 'Last commit undone'));
    }
    setResetInProgress(false);
    await refresh();
  }, [hasGitContext, resetInProgress, effectiveThreadId, projectModeId, refresh, t]);

  // ── Staging ──

  const handleStageFile = useCallback(
    async (path: string) => {
      if (!hasGitContext) return;
      const result = effectiveThreadId
        ? await gitApi.stageFiles(effectiveThreadId, [path])
        : await gitApi.projectStageFiles(projectModeId!, [path]);
      if (result.isErr()) {
        toast.error(t('review.stageFailed', { path, defaultValue: 'Failed to stage {{path}}' }));
      } else {
        toast.success(t('review.stageSuccess', { path, defaultValue: '{{path}} staged' }));
        await refresh();
      }
    },
    [hasGitContext, effectiveThreadId, projectModeId, refresh, t],
  );

  const handleUnstageFile = useCallback(
    async (path: string) => {
      if (!hasGitContext) return;
      const result = effectiveThreadId
        ? await gitApi.unstageFiles(effectiveThreadId, [path])
        : await gitApi.projectUnstageFiles(projectModeId!, [path]);
      if (result.isErr()) {
        toast.error(
          t('review.unstageFailed', { path, defaultValue: 'Failed to unstage {{path}}' }),
        );
      } else {
        toast.success(t('review.unstageSuccess', { path, defaultValue: '{{path}} unstaged' }));
        await refresh();
      }
    },
    [hasGitContext, effectiveThreadId, projectModeId, refresh, t],
  );

  const handleStageSelected = useCallback(async () => {
    if (!hasGitContext) return;
    const paths =
      checkedFiles.size > 0
        ? Array.from(checkedFiles).filter((p) => {
            const s = summaries.find((f) => f.path === p);
            return s && !s.staged;
          })
        : summaries.filter((f) => !f.staged).map((f) => f.path);
    if (paths.length === 0) {
      toast.info(t('review.allAlreadyStaged', { defaultValue: 'All files already staged' }));
      return;
    }
    const result = effectiveThreadId
      ? await gitApi.stageFiles(effectiveThreadId, paths)
      : await gitApi.projectStageFiles(projectModeId!, paths);
    if (result.isErr()) {
      toast.error(
        t('review.stageFailed', {
          path: `${paths.length} files`,
          defaultValue: 'Failed to stage {{path}}',
        }),
      );
    } else {
      toast.success(
        t('review.stageSelectedSuccess', {
          count: paths.length,
          defaultValue: '{{count}} file(s) staged',
        }),
      );
      await refresh();
    }
  }, [hasGitContext, checkedFiles, summaries, effectiveThreadId, projectModeId, refresh, t]);

  const handleUnstageAll = useCallback(async () => {
    if (!hasGitContext) return;
    const paths =
      checkedFiles.size > 0
        ? Array.from(checkedFiles).filter((p) => {
            const s = summaries.find((f) => f.path === p);
            return s && s.staged;
          })
        : summaries.filter((f) => f.staged).map((f) => f.path);
    if (paths.length === 0) {
      toast.info(t('review.noneStaged', { defaultValue: 'No staged files to unstage' }));
      return;
    }
    const result = effectiveThreadId
      ? await gitApi.unstageFiles(effectiveThreadId, paths)
      : await gitApi.projectUnstageFiles(projectModeId!, paths);
    if (result.isErr()) {
      toast.error(
        t('review.unstageFailed', {
          path: `${paths.length} files`,
          defaultValue: 'Failed to unstage {{path}}',
        }),
      );
    } else {
      toast.success(
        t('review.unstageSelectedSuccess', {
          count: paths.length,
          defaultValue: '{{count}} file(s) unstaged',
        }),
      );
      await refresh();
    }
  }, [hasGitContext, checkedFiles, summaries, effectiveThreadId, projectModeId, refresh, t]);

  const handleStagePatch = useCallback(
    async (patch: string) => {
      if (!hasGitContext) return;
      setPatchStagingInProgress(true);
      const result = effectiveThreadId
        ? await gitApi.stagePatch(effectiveThreadId, patch)
        : await gitApi.projectStagePatch(projectModeId!, patch);
      setPatchStagingInProgress(false);
      if (result.isErr()) {
        toastError(
          result.error,
          t('review.stageFailed', {
            path: 'selected lines',
            defaultValue: 'Failed to stage {{path}}',
          }),
        );
      } else {
        toast.success(t('review.stageLinesSuccess', { defaultValue: 'Selected lines staged' }));
        await refresh();
      }
    },
    [hasGitContext, effectiveThreadId, projectModeId, refresh, t],
  );

  const handleSelectionStateChange = useCallback(
    (filePath: string, state: 'all' | 'partial' | 'none') => {
      setFileSelectionState((prev) => {
        if (prev.get(filePath) === state) return prev;
        const next = new Map(prev);
        next.set(filePath, state);
        return next;
      });
    },
    [],
  );

  // ── Conflict resolution ──

  const handleResolveConflict = useCallback(
    async (blockId: number, resolution: 'ours' | 'theirs' | 'both') => {
      const filePath = expandedFile || selectedFile;
      if (!filePath || !hasGitContext) return;

      const resolutionLabel =
        resolution === 'ours' ? 'current' : resolution === 'theirs' ? 'incoming' : 'both';
      const result = effectiveThreadId
        ? await gitApi.resolveConflict(effectiveThreadId, filePath, blockId, resolution)
        : await gitApi.projectResolveConflict(projectModeId!, filePath, blockId, resolution);

      if (result.isErr()) {
        toast.error(`Failed to resolve conflict: ${result.error.message}`);
      } else {
        toast.success(
          `Conflict ${blockId + 1} resolved (${resolutionLabel})` +
            (result.value.remainingConflicts > 0
              ? ` — ${result.value.remainingConflicts} remaining`
              : ' — file resolved'),
        );
        // Clear cached diff so it reloads
        setDiffCache((prev) => {
          const next = new Map(prev);
          next.delete(filePath);
          return next;
        });
        // Reload the diff for this file
        loadDiffForFile(filePath);
        await refresh();
      }
    },
    [
      expandedFile,
      selectedFile,
      hasGitContext,
      effectiveThreadId,
      projectModeId,
      refresh,
      loadDiffForFile,
      setDiffCache,
    ],
  );

  const handleAskAgentResolve = useCallback(async () => {
    // Agent resolve only works with threads, not in project-only mode
    if (!effectiveThreadId) return;

    const target = baseBranch || 'main';
    const prompt = t('review.agentResolvePrompt', { target });
    const { allowedTools, disallowedTools } = deriveToolLists(
      useSettingsStore.getState().toolPermissions,
    );

    const result = await threadsApi.sendMessage(effectiveThreadId, prompt, {
      allowedTools,
      disallowedTools,
    });

    if (result.isErr()) {
      toastError(result.error);
      return;
    }

    toast.success(t('review.agentResolveSent'));
    setHasRebaseConflict(false);
  }, [effectiveThreadId, baseBranch, setHasRebaseConflict, t]);

  const handleOpenInEditorConflict = useCallback(() => {
    if (!effectiveThreadId) return;
    const worktreePath = getThreadById(effectiveThreadId)?.worktreePath;
    if (!worktreePath) return;
    const editor = useSettingsStore.getState().defaultEditor;
    browseApi.openInEditor(worktreePath, editor);
  }, [effectiveThreadId]);

  // ── Network: pull / fetch ──

  const runPull = useCallback(
    async (strategy: PullStrategy) => {
      const result = effectiveThreadId
        ? await gitApi.pull(effectiveThreadId, strategy)
        : await gitApi.projectPull(projectModeId!, strategy);
      if (result.isErr()) {
        const msg = result.error.message;
        // When ff-only fails because of a diverged branch, offer merge/rebase
        // instead of just surfacing the raw git hint to the user.
        if (strategy === 'ff-only' && isDivergedBranchesError(msg)) {
          setPullStrategyDialog({ open: true, errorMessage: msg });
          return;
        }
        toast.error(
          t('review.pullFailed', {
            message: msg,
            defaultValue: `Pull failed: ${msg}`,
          }),
        );
      } else {
        toast.success(t('review.pullSuccess', 'Pulled successfully'));
      }
      // Force-refresh git status so unpulled badge clears immediately after pull.
      if (effectiveThreadId) useGitStatusStore.getState().fetchForThread(effectiveThreadId, true);
      else if (projectModeId) useGitStatusStore.getState().fetchProjectStatus(projectModeId, true);
      await refresh();
    },
    [effectiveThreadId, projectModeId, refresh, t],
  );

  const handlePull = useCallback(async () => {
    if (!hasGitContext || pullInProgress) return;
    setPullInProgress(true);
    try {
      await runPull('ff-only');
    } finally {
      setPullInProgress(false);
    }
  }, [hasGitContext, pullInProgress, runPull]);

  const handlePullStrategyChosen = useCallback(
    async (strategy: Exclude<PullStrategy, 'ff-only'>) => {
      setPullStrategyDialog({ open: false, errorMessage: '' });
      if (pullInProgress) return;
      setPullInProgress(true);
      try {
        await runPull(strategy);
      } finally {
        setPullInProgress(false);
      }
    },
    [pullInProgress, runPull],
  );

  const handleFetchOrigin = useCallback(async () => {
    if (!hasGitContext || fetchInProgress) return;
    setFetchInProgress(true);
    const result = effectiveThreadId
      ? await gitApi.fetchOrigin(effectiveThreadId)
      : await gitApi.projectFetchOrigin(projectModeId!);
    if (result.isErr()) {
      const msg = result.error.message;
      const isAuthError =
        /auth|token|credential|permission|denied|403|fatal:/i.test(msg) ||
        result.error.type === 'INTERNAL';
      toast.error(
        isAuthError
          ? t('review.fetchAuthFailed', {
              defaultValue:
                'Fetch failed: authentication error. Check your GitHub token in Settings > Profile.',
            })
          : t('review.fetchFailed', {
              message: msg,
              defaultValue: `Fetch failed: ${msg}`,
            }),
      );
    } else {
      toast.success(t('review.fetchSuccess', 'Fetched from origin'));
    }
    setFetchInProgress(false);
    // Force-refresh git status to bypass client-side cooldown so unpulled/unpushed
    // counts update immediately after a manual fetch.
    if (effectiveThreadId) useGitStatusStore.getState().fetchForThread(effectiveThreadId, true);
    else if (projectModeId) useGitStatusStore.getState().fetchProjectStatus(projectModeId, true);
    await refresh();
  }, [hasGitContext, fetchInProgress, effectiveThreadId, projectModeId, refresh, t]);

  // ── Stash creation (popping/dropping is in useStashState) ──

  const handleStash = useCallback(async () => {
    if (!hasGitContext || stashInProgress) return;
    setStashInProgress(true);
    const result = effectiveThreadId
      ? await gitApi.stash(effectiveThreadId)
      : await gitApi.projectStash(projectModeId!);
    if (result.isErr()) {
      toast.error(
        t('review.stashFailed', {
          message: result.error.message,
          defaultValue: `Stash failed: ${result.error.message}`,
        }),
      );
    } else {
      toast.success(t('review.stashSuccess', 'Changes stashed'));
    }
    setStashInProgress(false);
    await refresh();
    refreshStashList();
  }, [
    hasGitContext,
    stashInProgress,
    effectiveThreadId,
    projectModeId,
    refresh,
    refreshStashList,
    t,
  ]);

  const handleStashSelected = useCallback(async () => {
    if (!hasGitContext || stashInProgress) return;
    const paths = checkedFiles.size > 0 ? Array.from(checkedFiles) : summaries.map((f) => f.path);
    if (paths.length === 0) return;
    setStashInProgress(true);
    const result = effectiveThreadId
      ? await gitApi.stash(effectiveThreadId, paths)
      : await gitApi.projectStash(projectModeId!, paths);
    if (result.isErr()) {
      toast.error(
        t('review.stashFailed', {
          message: result.error.message,
          defaultValue: `Stash failed: ${result.error.message}`,
        }),
      );
    } else {
      toast.success(
        t('review.stashSelectedSuccess', {
          count: paths.length,
          defaultValue: '{{count}} file(s) stashed',
        }),
      );
    }
    setStashInProgress(false);
    await refresh();
    refreshStashList();
  }, [
    hasGitContext,
    stashInProgress,
    checkedFiles,
    summaries,
    effectiveThreadId,
    projectModeId,
    refresh,
    refreshStashList,
    t,
  ]);

  // ── Filesystem ──

  const handleCopyPath = useCallback(
    (path: string, relative: boolean) => {
      const text = relative ? path : basePath ? `${basePath}/${path}` : path;
      navigator.clipboard.writeText(text);
      toast.success(t('review.pathCopied'));
    },
    [basePath, t],
  );

  const handleOpenDirectory = useCallback(
    async (relativePath: string, isFile: boolean) => {
      if (!basePath) return;
      const dirRelative = isFile
        ? relativePath.includes('/')
          ? relativePath.slice(0, relativePath.lastIndexOf('/'))
          : ''
        : relativePath;
      const absoluteDir = dirRelative ? `${basePath}/${dirRelative}` : basePath;
      const result = await browseApi.openDirectory(absoluteDir);
      if (result.isErr()) {
        log.error('Failed to open directory', {
          path: absoluteDir,
          error: String(result.error),
        });
        toast.error(t('review.openDirectoryError', 'Failed to open directory'));
      }
    },
    [basePath, t],
  );

  return {
    pullInProgress,
    fetchInProgress,
    stashInProgress,
    resetInProgress,
    patchStagingInProgress,
    pullStrategyDialog,
    setPullStrategyDialog,
    fileSelectionState,
    setFileSelectionState,
    selectAllSignal,
    setSelectAllSignal,
    deselectAllSignal,
    setDeselectAllSignal,
    handleRevertFile,
    executeRevert,
    handleDiscardAll,
    executeDiscardAll,
    handleIgnoreFiles,
    executeIgnoreFiles,
    handleIgnore,
    executeResetSoft,
    handleStageFile,
    handleUnstageFile,
    handleStageSelected,
    handleUnstageAll,
    handleStagePatch,
    handleSelectionStateChange,
    handleResolveConflict,
    handleAskAgentResolve,
    handleOpenInEditorConflict,
    handlePull,
    handlePullStrategyChosen,
    handleFetchOrigin,
    handleStash,
    handleStashSelected,
    handleCopyPath,
    handleOpenDirectory,
  };
}
