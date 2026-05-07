import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { CommitDetailDialog } from '@/components/commit-history/CommitDetailDialog';
import { CommitHistoryToolbar } from '@/components/commit-history/CommitHistoryToolbar';
import { CommitListPanel } from '@/components/commit-history/CommitListPanel';
import { CreatePRDialog, type PRDraft } from '@/components/commit-history/CreatePRDialog';
import { PublishRepoDialog } from '@/components/PublishRepoDialog';
import { isDivergedBranchesError, PullStrategyDialog } from '@/components/pull-strategy-dialog';
import { api, type PullStrategy } from '@/lib/api';
import { toastError } from '@/lib/toast-error';
import { resolveThreadBranch } from '@/lib/utils';
import { useGitStatusForThread, useGitStatusStore } from '@/stores/git-status-store';
import { useProjectStore } from '@/stores/project-store';
import { useThreadProjectId, useThreadSelector, useThreadStatus } from '@/stores/thread-context';
import { useThreadStore } from '@/stores/thread-store';

interface LogEntry {
  hash: string;
  shortHash: string;
  author: string;
  authorEmail: string;
  relativeDate: string;
  message: string;
}

const PAGE_SIZE = 50;
const SELECTED_COMMIT_KEY = 'history_selected_commit';

interface CommitHistoryTabProps {
  visible?: boolean;
}

export function CommitHistoryTab({ visible }: CommitHistoryTabProps) {
  const { t } = useTranslation();
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId);
  const effectiveThreadId = useThreadStore((s) => s.selectedThreadId) || undefined;
  const projectModeId = !effectiveThreadId ? selectedProjectId : null;
  const hasGitContext = !!(effectiveThreadId || projectModeId);

  const baseBranch = useThreadSelector((t) => t?.baseBranch);
  const threadBranch = useThreadSelector((t) => (t ? resolveThreadBranch(t) : undefined));
  const isAgentRunning = useThreadStatus() === 'running';
  const threadGitStatus = useGitStatusForThread(effectiveThreadId);
  const projectGitStatus = useGitStatusStore((s) =>
    projectModeId ? s.statusByProject[projectModeId] : undefined,
  );
  const gitStatus = threadGitStatus ?? projectGitStatus;
  const isOnDifferentBranch =
    !!effectiveThreadId && !!baseBranch && !!threadBranch && threadBranch !== baseBranch;

  const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
  const [logLoading, setLogLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [unpushedHashes, setUnpushedHashes] = useState<Set<string>>(new Set());
  const loadedRef = useRef(false);
  const loadingRef = useRef(false);

  const [pullInProgress, setPullInProgress] = useState(false);
  const [pullStrategyDialog, setPullStrategyDialog] = useState<{
    open: boolean;
    errorMessage: string;
  }>({ open: false, errorMessage: '' });
  const [fetchInProgress, setFetchInProgress] = useState(false);
  const [pushInProgress, setPushInProgress] = useState(false);
  const [prInProgress, setPrInProgress] = useState(false);
  const [prDialog, setPrDialog] = useState<PRDraft | null>(null);

  const [selectedHash, setSelectedHashRaw] = useState<string | null>(() => {
    try {
      return localStorage.getItem(SELECTED_COMMIT_KEY);
    } catch {
      return null;
    }
  });
  const setSelectedHash = useCallback((hash: string | null) => {
    try {
      if (hash) localStorage.setItem(SELECTED_COMMIT_KEY, hash);
      else localStorage.removeItem(SELECTED_COMMIT_KEY);
    } catch {}
    setSelectedHashRaw(hash);
  }, []);

  const [githubAvatarBySha, setGithubAvatarBySha] = useState<Map<string, string>>(new Map());

  const [remoteUrl, setRemoteUrl] = useState<string | null | undefined>(undefined);
  const [publishDialogOpen, setPublishDialogOpen] = useState(false);

  const threadProjectId = useThreadProjectId();
  const projectBranch = useProjectStore((s) => {
    const pid = projectModeId ?? threadProjectId;
    return pid ? s.branchByProject[pid] : undefined;
  });
  const isWorktreeMode = useThreadSelector((t) => t?.mode === 'worktree');
  const effectiveBranch = isWorktreeMode ? threadBranch : projectBranch;

  const gitContextKey = `${effectiveThreadId || projectModeId || ''}::${effectiveBranch ?? ''}`;

  const remoteCheckProjectId = projectModeId ?? threadProjectId ?? null;
  const projectPathForPublish = useProjectStore((s) => {
    if (!remoteCheckProjectId) return '';
    return s.projects.find((p) => p.id === remoteCheckProjectId)?.path ?? '';
  });

  useEffect(() => {
    if (!remoteCheckProjectId) {
      setRemoteUrl(undefined);
      return;
    }
    if (gitStatus?.hasRemoteBranch) {
      setRemoteUrl('exists');
      return;
    }
    const controller = new AbortController();
    api.projectGetRemoteUrl(remoteCheckProjectId, controller.signal).then((r) => {
      if (!controller.signal.aborted && r.isOk()) {
        setRemoteUrl(r.value.remoteUrl);
      }
    });
    return () => controller.abort();
  }, [remoteCheckProjectId, gitStatus?.hasRemoteBranch]);

  const abortRef = useRef<AbortController | null>(null);

  const loadLog = useCallback(
    async (skip = 0, append = false) => {
      if (!hasGitContext || loadingRef.current) return;
      loadingRef.current = true;
      setLogLoading(true);
      const signal = abortRef.current?.signal;
      const result = effectiveThreadId
        ? await api.getGitLog(effectiveThreadId, PAGE_SIZE, true, skip, signal)
        : await api.projectGitLog(projectModeId!, PAGE_SIZE, skip, signal);
      if (signal?.aborted) {
        loadingRef.current = false;
        return;
      }
      if (result.isOk()) {
        const { entries, hasMore: more, unpushedHashes: hashes } = result.value;
        setLogEntries((prev) => (append ? [...prev, ...entries] : entries));
        setHasMore(more);
        if (hashes) {
          setUnpushedHashes((prev) => {
            if (!append) return new Set(hashes);
            const next = new Set(prev);
            for (const h of hashes) next.add(h);
            return next;
          });
        } else if (!append) {
          setUnpushedHashes(new Set());
        }
      } else if (!signal?.aborted && result.error.message !== 'Request aborted') {
        toast.error(
          t('review.logFailed', {
            message: result.error.message,
            defaultValue: `Failed to load log: ${result.error.message}`,
          }),
        );
      }
      setLogLoading(false);
      loadingRef.current = false;
    },
    [hasGitContext, effectiveThreadId, projectModeId, t],
  );

  const loadMore = useCallback(() => {
    if (!hasMore || loadingRef.current) return;
    loadLog(logEntries.length, true);
  }, [hasMore, logEntries.length, loadLog]);

  const refreshLog = useCallback(() => {
    loadedRef.current = false;
    loadLog(0, false);
  }, [loadLog]);

  // Auto-load on mount / context change
  const prevContextRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const isInitialMount = prevContextRef.current === undefined;
    const contextChanged = prevContextRef.current !== gitContextKey;
    prevContextRef.current = gitContextKey ?? null;
    if (!contextChanged) return;

    abortRef.current?.abort();
    abortRef.current = new AbortController();
    loadingRef.current = false;
    loadedRef.current = false;
    if (!isInitialMount && visible && hasGitContext) {
      setLogLoading(true);
    }
    setLogEntries([]);
    setHasMore(false);
    setUnpushedHashes(new Set());
    if (!isInitialMount) {
      setSelectedHash(null);
    }
    if (!isInitialMount && visible && hasGitContext) {
      loadedRef.current = true;
      loadLog(0, false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally only trigger on context change
  }, [gitContextKey, setSelectedHash]);

  useEffect(() => {
    if (visible && hasGitContext && !loadedRef.current) {
      loadedRef.current = true;
      loadLog(0, false);
    }
  }, [visible, hasGitContext, loadLog]);

  const prevVisibleRef = useRef(visible);
  useEffect(() => {
    const wasHidden = prevVisibleRef.current === false;
    prevVisibleRef.current = visible;
    if (visible && wasHidden && hasGitContext && loadedRef.current) {
      loadLog(0, false);
    }
  }, [visible, hasGitContext, loadLog]);

  // Reset GitHub avatars when git context changes
  const anchoredShasRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    setGithubAvatarBySha(new Map());
    anchoredShasRef.current = new Set();
  }, [gitContextKey]);

  // Walk GitHub commit author endpoint anchored at the first uncovered SHA.
  const ghProjectId = projectModeId ?? threadProjectId ?? null;
  useEffect(() => {
    if (!ghProjectId || logEntries.length === 0) return;
    const firstMissing = logEntries.find(
      (e) => !githubAvatarBySha.has(e.hash) && !anchoredShasRef.current.has(e.hash),
    );
    if (!firstMissing) return;
    anchoredShasRef.current.add(firstMissing.hash);
    let cancelled = false;
    api
      .githubCommitAuthors(ghProjectId, { sha: firstMissing.hash, per_page: 100 })
      .then((result) => {
        if (cancelled || result.isErr()) return;
        const authors = result.value.authors;
        if (authors.length === 0) return;
        setGithubAvatarBySha((prev) => {
          const next = new Map(prev);
          for (const a of authors) {
            if (a.avatar_url) next.set(a.sha, a.avatar_url);
          }
          return next;
        });
      });
    return () => {
      cancelled = true;
    };
  }, [ghProjectId, logEntries, githubAvatarBySha]);

  const selectedCommit = logEntries.find((e) => e.hash === selectedHash);
  const hasUnpushed = unpushedHashes.size > 0;

  const runPull = useCallback(
    async (strategy: PullStrategy) => {
      const result = effectiveThreadId
        ? await api.pull(effectiveThreadId, strategy)
        : await api.projectPull(projectModeId!, strategy);
      if (result.isErr()) {
        const msg = result.error.message;
        if (strategy === 'ff-only' && isDivergedBranchesError(msg)) {
          setPullStrategyDialog({ open: true, errorMessage: msg });
          return;
        }
        toast.error(t('review.pullFailed', { message: msg, defaultValue: `Pull failed: ${msg}` }));
      } else {
        toast.success(t('review.pullSuccess', 'Pulled successfully'));
      }
      if (effectiveThreadId) useGitStatusStore.getState().fetchForThread(effectiveThreadId, true);
      else if (projectModeId) useGitStatusStore.getState().fetchProjectStatus(projectModeId, true);
      refreshLog();
    },
    [effectiveThreadId, projectModeId, t, refreshLog],
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
      ? await api.fetchOrigin(effectiveThreadId)
      : await api.projectFetchOrigin(projectModeId!);
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
          : t('review.fetchFailed', { message: msg, defaultValue: `Fetch failed: ${msg}` }),
      );
    } else {
      toast.success(t('review.fetchSuccess', 'Fetched from origin'));
    }
    setFetchInProgress(false);
    if (effectiveThreadId) useGitStatusStore.getState().fetchForThread(effectiveThreadId, true);
    else if (projectModeId) useGitStatusStore.getState().fetchProjectStatus(projectModeId, true);
    refreshLog();
  }, [hasGitContext, fetchInProgress, effectiveThreadId, projectModeId, t, refreshLog]);

  const handlePush = useCallback(async () => {
    if (!hasGitContext || pushInProgress) return;
    setPushInProgress(true);
    const result = effectiveThreadId
      ? await api.startWorkflow(effectiveThreadId, { action: 'push' })
      : await api.projectStartWorkflow(projectModeId!, { action: 'push' });
    if (result.isErr()) {
      toast.error(
        t('review.pushFailed', {
          message: result.error.message,
          defaultValue: `Push failed: ${result.error.message}`,
        }),
      );
      setPushInProgress(false);
    } else {
      setPushInProgress(false);
      refreshLog();
    }
  }, [hasGitContext, pushInProgress, effectiveThreadId, projectModeId, t, refreshLog]);

  const handleCreatePR = useCallback(async () => {
    if (!hasGitContext || prInProgress || !prDialog) return;
    setPrInProgress(true);
    const result = effectiveThreadId
      ? await api.startWorkflow(effectiveThreadId, {
          action: 'create-pr',
          prTitle: prDialog.title.trim(),
          prBody: prDialog.body.trim(),
        })
      : await api.projectStartWorkflow(projectModeId!, {
          action: 'create-pr',
          prTitle: prDialog.title.trim(),
          prBody: prDialog.body.trim(),
        });
    if (result.isErr()) {
      toastError(result.error);
      setPrInProgress(false);
      return;
    }
    setPrDialog(null);
    setPrInProgress(false);
  }, [hasGitContext, prInProgress, prDialog, effectiveThreadId, projectModeId]);

  if (!hasGitContext) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-xs text-muted-foreground">
        {t('review.noProject', 'Select a project to view history')}
      </div>
    );
  }

  return (
    <div
      className="flex h-full w-full min-w-0 flex-col overflow-hidden"
      data-testid="commit-history-tab"
    >
      <CommitHistoryToolbar
        logLoading={logLoading}
        unpulledCommitCount={gitStatus?.unpulledCommitCount ?? 0}
        unpushedCount={unpushedHashes.size}
        hasUnpushed={hasUnpushed}
        pullInProgress={pullInProgress}
        fetchInProgress={fetchInProgress}
        pushInProgress={pushInProgress}
        remoteUrl={remoteUrl}
        isOnDifferentBranch={isOnDifferentBranch}
        isAgentRunning={!!isAgentRunning}
        prNumber={gitStatus?.prNumber ?? undefined}
        prState={gitStatus?.prState ?? undefined}
        prUrl={gitStatus?.prUrl ?? undefined}
        onRefresh={refreshLog}
        onPull={handlePull}
        onFetch={handleFetchOrigin}
        onPush={handlePush}
        onPublish={() => setPublishDialogOpen(true)}
        onCreatePR={() => setPrDialog({ title: threadBranch || '', body: '' })}
      />

      <CommitListPanel
        logEntries={logEntries}
        logLoading={logLoading}
        hasMore={hasMore}
        unpushedHashes={unpushedHashes}
        githubAvatarBySha={githubAvatarBySha}
        selectedHash={selectedHash}
        onSelectHash={setSelectedHash}
        onLoadMore={loadMore}
      />

      <CommitDetailDialog
        selectedCommit={selectedCommit}
        selectedHash={selectedHash}
        effectiveThreadId={effectiveThreadId}
        projectModeId={projectModeId}
        githubAvatarBySha={githubAvatarBySha}
        onClose={() => setSelectedHash(null)}
        onAfterAction={refreshLog}
      />

      <CreatePRDialog
        draft={prDialog}
        threadBranch={threadBranch}
        baseBranch={baseBranch}
        inProgress={prInProgress}
        onChange={setPrDialog}
        onSubmit={handleCreatePR}
      />

      <PullStrategyDialog
        open={pullStrategyDialog.open}
        onOpenChange={(open) => setPullStrategyDialog((s) => ({ ...s, open }))}
        errorMessage={pullStrategyDialog.errorMessage}
        onChoose={handlePullStrategyChosen}
      />

      <PublishRepoDialog
        projectId={remoteCheckProjectId ?? ''}
        projectPath={projectPathForPublish}
        open={publishDialogOpen}
        onOpenChange={setPublishDialogOpen}
        onSuccess={(repoUrl) => {
          setRemoteUrl(repoUrl);
          setPublishDialogOpen(false);
          if (remoteCheckProjectId) {
            useGitStatusStore.getState().fetchProjectStatus(remoteCheckProjectId, true);
          }
          toast.success(t('review.publishSuccess', 'Repository ready'));
          refreshLog();
        }}
      />
    </div>
  );
}
