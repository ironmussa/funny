import { DEFAULT_THREAD_MODE } from '@funny/shared/models';
import { SiGithub } from '@icons-pack/react-simple-icons';
import { CircleDot, FolderOpen, GitBranch, GitFork, Globe, Loader2 } from 'lucide-react';
import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { LoadingState } from '@/components/ui/loading-state';
import { useBranchSwitch } from '@/hooks/use-branch-switch';
import { useSaveBacklogOnLeave } from '@/hooks/use-save-backlog-on-leave';
import { useThreadCreation } from '@/hooks/use-thread-creation';
import { api } from '@/lib/api';
import { getThreadRoute } from '@/lib/thread-variant';
import { buildPath } from '@/lib/url';
import { useBranchPickerStore } from '@/stores/branch-picker-store';
import { useProjectStore } from '@/stores/project-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useThreadStore } from '@/stores/thread-store';
import { useUIStore } from '@/stores/ui-store';

import { AvailableMcpServers } from '../AvailableMcpServers';
import { PromptInput } from '../PromptInput';
import { formatRemoteUrl, remoteUrlToBrowseUrl } from '../PromptInputUI';
import { BranchPicker } from '../SearchablePicker';
import { SaveBacklogDialog } from './SaveBacklogDialog';

/** Replicate server-side slugifyTitle for branch name preview. */
function slugifyTitle(title: string, maxLength = 40): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .slice(0, maxLength)
      .replace(/-$/, '') || 'thread'
  );
}

interface NewThreadInputProps {
  /** Override the project ID (skips reading from global stores). */
  projectIdOverride?: string;
  /** Force scratch mode regardless of the global UI store flag. */
  isScratchOverride?: boolean;
  /** Called after a thread is successfully created. If provided, navigation is skipped. */
  onCreated?: (threadId: string) => void;
  /** Called when the user cancels (replaces the default global cancelNewThread). */
  onCancel?: () => void;
}

export function NewThreadInput({
  projectIdOverride,
  isScratchOverride,
  onCreated,
  onCancel,
}: NewThreadInputProps = {}) {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const newThreadProjectId = useUIStore((s) => s.newThreadProjectId);
  const newThreadIsScratchStore = useUIStore((s) => s.newThreadIsScratch);
  const newThreadIsScratch = isScratchOverride ?? newThreadIsScratchStore;
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId);
  const effectiveProjectId = projectIdOverride || selectedProjectId || newThreadProjectId;
  const newThreadIdleOnly = useUIStore((s) => s.newThreadIdleOnly);
  const addScratchThread = useThreadStore((s) => s.addScratchThread);
  const activeDesignId = useUIStore((s) => s.activeDesignId);
  const issueContext = useUIStore((s) => s.newThreadIssueContext);
  const clearIssueContext = useUIStore((s) => s.clearIssueContext);
  const composePrefillPrompt = useUIStore((s) => s.composePrefillPrompt);
  const setComposePrefillPrompt = useUIStore((s) => s.setComposePrefillPrompt);
  // One-shot: capture the prefill at mount time, then clear it from the store
  // so it doesn't bleed into the next compose. The captured value is what
  // gets passed to PromptInput as initialPrompt.
  const initialPrefillRef = useRef(composePrefillPrompt);
  useEffect(() => {
    if (composePrefillPrompt !== null) setComposePrefillPrompt(null);
    // Run once at mount; do NOT re-run when the store value flips back to null.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const cancelNewThreadGlobal = useUIStore((s) => s.cancelNewThread);
  const cancelNewThread = onCancel ?? cancelNewThreadGlobal;
  const setReviewPaneOpen = useUIStore((s) => s.setReviewPaneOpen);
  const loadThreadsForProject = useThreadStore((s) => s.loadThreadsForProject);
  const projects = useProjectStore((s) => s.projects);
  const project = effectiveProjectId
    ? projects.find((p) => p.id === effectiveProjectId)
    : undefined;
  const defaultThreadMode = project?.defaultMode ?? DEFAULT_THREAD_MODE;
  const toolPermissions = useSettingsStore((s) => s.toolPermissions);

  // ── Branch picker (shared store) ──
  const branchPickerBranches = useBranchPickerStore((s) => s.branches);
  const branchPickerRemoteBranches = useBranchPickerStore((s) => s.remoteBranches);
  const branchPickerDefaultBranch = useBranchPickerStore((s) => s.defaultBranch);
  const branchPickerLoading = useBranchPickerStore((s) => s.loading);
  const branchPickerSelected = useBranchPickerStore((s) => s.selectedBranch);
  const branchPickerSetSelected = useBranchPickerStore((s) => s.setSelectedBranch);
  const branchPickerCurrentBranch = useBranchPickerStore((s) => s.currentBranch);

  // ── Branch switch on selection (checkout so ReviewPane shows accurate data) ──
  const { ensureBranch, branchSwitchDialog } = useBranchSwitch();
  const handleBranchChange = useCallback(
    async (branch: string) => {
      // Checkout first so the picker only moves once the branch is actually live.
      // ensureBranch is a no-op if already on the target branch, and returns
      // false if the user cancels the dirty-files dialog or the checkout fails.
      if (effectiveProjectId && branch !== branchPickerCurrentBranch) {
        const ok = await ensureBranch(effectiveProjectId, branch);
        if (!ok) return;
      }
      branchPickerSetSelected(branch);
    },
    [branchPickerSetSelected, effectiveProjectId, branchPickerCurrentBranch, ensureBranch],
  );

  // ── Remote URL ──
  const projectPath = useMemo(() => project?.path ?? '', [project?.path]);
  const [remoteUrl, setRemoteUrl] = useState<string | null>(null);
  useEffect(() => {
    if (projectPath) {
      (async () => {
        const result = await api.remoteUrl(projectPath);
        if (result.isOk()) setRemoteUrl(result.value.url);
        else setRemoteUrl(null);
      })();
    } else {
      setRemoteUrl(null);
    }
  }, [projectPath]);

  // ── Worktree preview ──
  const [previewBranch, setPreviewBranch] = useState<string | null>(null);
  const [isWorktreeMode, setIsWorktreeMode] = useState(defaultThreadMode === 'worktree');

  // ── Save-to-backlog guard ──
  const hasContentRef = useRef(false);
  const latestPromptTextRef = useRef('');
  // Skip blocking when the user just submitted (created a thread successfully)
  const justSubmittedRef = useRef(false);

  const handleContentChange = useCallback(
    (hasContent: boolean, text: string) => {
      hasContentRef.current = hasContent;
      latestPromptTextRef.current = text;
      // Update worktree preview branch name (mirrors server-side naming)
      if (hasContent && text.trim()) {
        const projectSlug = slugifyTitle(project?.name || 'project');
        const titleSlug = slugifyTitle(text.slice(0, 200));
        setPreviewBranch(`${projectSlug}/${titleSlug}-xxxxxx`);
      } else {
        setPreviewBranch(null);
      }
    },
    [project?.name],
  );

  const { blocker, savingBacklog, handleSaveToBacklog, handleDiscard, handleCancel } =
    useSaveBacklogOnLeave({
      effectiveProjectId: effectiveProjectId ?? undefined,
      defaultThreadMode,
      latestPromptTextRef,
      hasContentRef,
      justSubmittedRef,
    });

  const [restoredPrompt, setRestoredPrompt] = useState<string | null>(null);
  const lastPromptRef = useRef('');

  const { creating, createThread: createThreadFromHook } = useThreadCreation({
    projectId: newThreadIsScratch ? null : (effectiveProjectId ?? null),
    defaultThreadMode,
    toolPermissions,
    isScratch: newThreadIsScratch,
    forceIdle: newThreadIdleOnly,
    designId: activeDesignId ?? undefined,
    onSuccess: async (threadId, kind, thread) => {
      // justSubmittedRef tells the unsaved-prompt guard to let the navigate
      // through. Only scratch + normal navigate; idle stays in place.
      if (kind === 'scratch' || kind === 'normal') {
        justSubmittedRef.current = true;
      }
      setReviewPaneOpen(false);

      if (kind === 'scratch') {
        addScratchThread(thread);
        if (onCreated) {
          onCreated(threadId);
        } else {
          useThreadStore.setState({ selectedThreadId: threadId });
          cancelNewThread();
          navigate(buildPath(getThreadRoute(thread)));
        }
        return;
      }

      // Idle + normal both refresh the project's thread list.
      if (effectiveProjectId) {
        await loadThreadsForProject(effectiveProjectId);
      }

      if (kind === 'idle') {
        toast.success(t('toast.threadCreated', { title: thread?.title ?? '' }));
        if (onCreated) {
          onCreated(threadId);
        } else {
          cancelNewThread();
        }
        return;
      }

      // kind === 'normal'
      if (onCreated) {
        onCreated(threadId);
      } else {
        useThreadStore.setState({ selectedThreadId: threadId });
        cancelNewThread();
        // Inside a design view, stay in the design view — the design's
        // thread list picks up the new thread automatically.
        if (!activeDesignId && effectiveProjectId) {
          navigate(buildPath(`/projects/${effectiveProjectId}/threads/${threadId}`));
        }
      }
    },
  });

  const handleCreate = useCallback(
    async (
      prompt: string,
      opts: Parameters<typeof createThreadFromHook>[1],
      images?: any[],
    ): Promise<boolean> => {
      // Reset restored-prompt before the call so the field clears if it succeeds.
      setRestoredPrompt(null);
      lastPromptRef.current = prompt;
      const ok = await createThreadFromHook(prompt, opts, images);
      if (!ok) {
        // Restore the user's text so they don't lose it on a failed submit.
        setRestoredPrompt(lastPromptRef.current);
      }
      return ok;
    },
    [createThreadFromHook],
  );

  if (creating) {
    return (
      <div className="text-muted-foreground flex flex-1 items-center justify-center px-4">
        <LoadingState testId="new-thread-creating" label={t('common.preparing', 'Preparing…')} />
      </div>
    );
  }

  if (newThreadIsScratch) {
    // Scratch variant: no project/repo/branch picker, no worktree preview,
    // no file/symbol references. Just a prompt + model/permission picker.
    // The handleCreate() branch above routes to api.createScratchThread().
    return (
      <div
        className="text-muted-foreground flex flex-1 items-center justify-center px-4"
        data-testid="new-thread-scratch"
      >
        <div className="w-full max-w-3xl">
          <div
            className="text-muted-foreground mb-3 flex h-9 items-center gap-2 text-base"
            data-testid="new-thread-context-bar"
          >
            <span className="flex h-9 shrink-0 items-center gap-1.5 px-2 py-1">
              <FolderOpen className="size-5 shrink-0" />
              <span className="truncate font-medium" data-testid="new-thread-scratch-label">
                {t('scratch.composeTitle', { defaultValue: 'New scratch thread' })}
              </span>
            </span>
          </div>
          <div data-testid="new-thread-scratch-prompt">
            <PromptInput
              key="scratch"
              onSubmit={handleCreate}
              loading={creating}
              isNewThread
              isScratch
              onContentChange={handleContentChange}
              initialPrompt={restoredPrompt ?? undefined}
            />
          </div>
        </div>
      </div>
    );
  }

  // Context bar content (project / repo / branch) — rendered by the prompt input
  // at the top, next to the worktree switch. Compact styling to match the input.
  const contextBar = (
    <>
      {project && (
        <span
          className="flex max-w-[140px] min-w-0 items-center gap-1 md:max-w-[200px]"
          title={project.name}
        >
          <FolderOpen className="size-4 shrink-0" />
          <span className="flex min-w-0 items-center font-medium">
            <span className="truncate">{project.name.slice(0, -8)}</span>
            <span className="shrink-0">{project.name.slice(-8)}</span>
          </span>
        </span>
      )}
      {project && remoteUrl && (
        <>
          <span className="text-muted-foreground/40 shrink-0">/</span>
          {(() => {
            const browseUrl = remoteUrlToBrowseUrl(remoteUrl);
            const Icon = remoteUrl.includes('github.com') ? SiGithub : Globe;
            const formatted = formatRemoteUrl(remoteUrl);
            const content = (
              <>
                <Icon className="size-4 shrink-0" />
                <span className="flex min-w-0 items-center font-medium">
                  <span className="truncate">{formatted.slice(0, -8)}</span>
                  <span className="shrink-0">{formatted.slice(-8)}</span>
                </span>
              </>
            );
            return browseUrl ? (
              <a
                href={browseUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:bg-muted hover:text-foreground flex max-w-[180px] min-w-0 items-center gap-1 rounded px-1 py-0.5 transition-colors md:max-w-[280px]"
                data-testid="new-thread-repo-link"
                title={browseUrl}
              >
                {content}
              </a>
            ) : (
              <span className="flex max-w-[180px] min-w-0 items-center gap-1 md:max-w-[280px]">
                {content}
              </span>
            );
          })()}
        </>
      )}
      {(branchPickerBranches.length > 0 || branchPickerLoading) && (
        <>
          <span className="text-muted-foreground/40">/</span>
          {branchPickerLoading ? (
            <span className="flex items-center gap-1">
              <GitBranch className="size-4 shrink-0" />
              <Loader2 className="size-4 animate-spin" />
            </span>
          ) : (
            <BranchPicker
              branches={branchPickerBranches}
              remoteBranches={branchPickerRemoteBranches}
              defaultBranch={branchPickerDefaultBranch}
              selected={branchPickerSelected}
              onChange={handleBranchChange}
              showCreateNew
              testId="new-thread-branch-picker"
              triggerClassName="flex max-w-[300px] items-center gap-1.5 truncate rounded px-1.5 py-0.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-hidden [&_svg]:h-4 [&_svg]:w-4"
            />
          )}
        </>
      )}
    </>
  );

  return (
    <div className="text-muted-foreground flex flex-1 items-center justify-center px-4">
      <div className="w-full max-w-3xl">
        {issueContext && (
          <div
            className="mb-1.5 flex items-center gap-1.5 rounded-md border border-emerald-500/20 bg-emerald-500/5 px-2 py-1 text-xs"
            data-testid="issue-context-banner"
          >
            <CircleDot className="size-3.5 shrink-0 text-emerald-500" />
            <span className="text-muted-foreground truncate">
              {t('issues.creatingFromIssue', { title: issueContext.title })}
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto h-5 px-1 text-[10px]"
              onClick={clearIssueContext}
              data-testid="issue-context-dismiss"
            >
              {t('common.dismiss')}
            </Button>
          </div>
        )}
        {isWorktreeMode && previewBranch && (
          <div
            className="text-muted-foreground/60 mb-1.5 flex items-center gap-1.5 text-[10px]"
            data-testid="worktree-preview"
          >
            <GitFork className="size-3 shrink-0" />
            <span className="truncate font-mono">{previewBranch}</span>
          </div>
        )}
        <PromptInput
          key={
            issueContext
              ? `${effectiveProjectId}-issue`
              : initialPrefillRef.current
                ? `${effectiveProjectId}-prefill-${initialPrefillRef.current.length}`
                : effectiveProjectId
          }
          onSubmit={handleCreate}
          loading={creating}
          isNewThread
          showBacklog
          newThreadContextBar={contextBar}
          projectId={effectiveProjectId || undefined}
          initialPrompt={
            issueContext?.prompt ?? initialPrefillRef.current ?? restoredPrompt ?? undefined
          }
          onContentChange={handleContentChange}
          onWorktreeModeChange={setIsWorktreeMode}
        />
        <AvailableMcpServers
          projectPath={projectPath || undefined}
          projectId={effectiveProjectId || undefined}
        />
      </div>

      <SaveBacklogDialog
        open={blocker.state === 'blocked'}
        loading={savingBacklog}
        onSave={handleSaveToBacklog}
        onDiscard={handleDiscard}
        onCancel={handleCancel}
      />
      {branchSwitchDialog}
    </div>
  );
}
