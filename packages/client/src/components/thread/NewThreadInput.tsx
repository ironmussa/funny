import { DEFAULT_THREAD_MODE } from '@funny/shared/models';
import { CircleDot, FolderOpen, GitBranch, GitFork, Globe, Github, Loader2 } from 'lucide-react';
import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { useBranchSwitch } from '@/hooks/use-branch-switch';
import { useSaveBacklogOnLeave } from '@/hooks/use-save-backlog-on-leave';
import { api } from '@/lib/api';
import { toastError } from '@/lib/toast-error';
import { buildPath } from '@/lib/url';
import { useBranchPickerStore } from '@/stores/branch-picker-store';
import { useProjectStore } from '@/stores/project-store';
import { useSettingsStore, deriveToolLists } from '@/stores/settings-store';
import { useThreadStore } from '@/stores/thread-store';
import { useUIStore } from '@/stores/ui-store';

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
  /** Called after a thread is successfully created. If provided, navigation is skipped. */
  onCreated?: (threadId: string) => void;
  /** Called when the user cancels (replaces the default global cancelNewThread). */
  onCancel?: () => void;
}

export function NewThreadInput({
  projectIdOverride,
  onCreated,
  onCancel,
}: NewThreadInputProps = {}) {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const newThreadProjectId = useUIStore((s) => s.newThreadProjectId);
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId);
  const effectiveProjectId = projectIdOverride || selectedProjectId || newThreadProjectId;
  const newThreadIdleOnly = useUIStore((s) => s.newThreadIdleOnly);
  const activeDesignId = useUIStore((s) => s.activeDesignId);
  const issueContext = useUIStore((s) => s.newThreadIssueContext);
  const clearIssueContext = useUIStore((s) => s.clearIssueContext);
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
      effectiveProjectId,
      defaultThreadMode,
      latestPromptTextRef,
      hasContentRef,
      justSubmittedRef,
    });

  const [creating, setCreating] = useState(false);

  const handleCreate = async (
    prompt: string,
    opts: {
      provider?: string;
      model: string;
      mode: string;
      effort?: string;
      threadMode?: string;
      runtime?: string;
      baseBranch?: string;
      sendToBacklog?: boolean;
      fileReferences?: { path: string }[];
      symbolReferences?: {
        path: string;
        name: string;
        kind: string;
        line: number;
        endLine?: number;
      }[];
      agentTemplateId?: string;
      templateVariables?: Record<string, string>;
    },
    images?: any[],
  ): Promise<boolean> => {
    if (!effectiveProjectId || creating) return false;
    setCreating(true);

    const threadMode = (opts.threadMode as 'local' | 'worktree') || defaultThreadMode;

    // If idle-only mode or sendToBacklog toggle, create idle thread without executing
    if (newThreadIdleOnly || opts.sendToBacklog) {
      const result = await api.createIdleThread({
        projectId: effectiveProjectId,
        title: prompt.slice(0, 200),
        mode: threadMode,
        baseBranch: opts.baseBranch,
        prompt,
        images,
        designId: activeDesignId ?? undefined,
      });

      if (result.isErr()) {
        toastError(result.error, 'createThread');
        setCreating(false);
        return false;
      }

      await loadThreadsForProject(effectiveProjectId);
      setCreating(false);
      setReviewPaneOpen(false);
      toast.success(t('toast.threadCreated', { title: prompt.slice(0, 200) }));
      if (onCreated) {
        onCreated(result.value.id);
      } else {
        cancelNewThread();
      }
      return true;
    }

    // Normal mode: create and execute thread
    const { allowedTools, disallowedTools } = deriveToolLists(toolPermissions);
    const result = await api.createThread({
      projectId: effectiveProjectId,
      title: prompt.slice(0, 200),
      mode: threadMode,
      runtime: opts.runtime as 'local' | 'remote' | undefined,
      provider: opts.provider,
      model: opts.model,
      permissionMode: opts.mode,
      effort: opts.effort,
      baseBranch: opts.baseBranch,
      prompt,
      images,
      allowedTools,
      disallowedTools,
      fileReferences: opts.fileReferences,
      symbolReferences: opts.symbolReferences,
      designId: activeDesignId ?? undefined,
      agentTemplateId: opts.agentTemplateId,
      templateVariables: opts.templateVariables,
    });

    if (result.isErr()) {
      toastError(result.error, 'createThread');
      setCreating(false);
      return false;
    }

    // Thread created — skip the blocker and select the new thread.
    justSubmittedRef.current = true;
    setCreating(false);
    setReviewPaneOpen(false);
    if (onCreated) {
      onCreated(result.value.id);
    } else {
      useThreadStore.setState({ selectedThreadId: result.value.id });
      cancelNewThread();
      // When inside a design, stay in the design view; the design's thread list
      // will pick up the new thread and the chat column will render it.
      if (!activeDesignId) {
        navigate(buildPath(`/projects/${effectiveProjectId}/threads/${result.value.id}`));
      }
    }
    loadThreadsForProject(effectiveProjectId);
    return true;
  };

  return (
    <div className="flex flex-1 items-center justify-center px-4 text-muted-foreground">
      <div className="w-full max-w-3xl">
        {/* Context bar: Project / Repo / Branch */}
        <div
          className="mb-3 flex h-9 items-center gap-2 text-base text-muted-foreground"
          data-testid="new-thread-context-bar"
        >
          {project && (
            <span className="flex h-9 shrink-0 items-center gap-1.5 px-2 py-1">
              <FolderOpen className="h-5 w-5 shrink-0" />
              <span className="truncate font-medium">{project.name}</span>
            </span>
          )}
          {project && remoteUrl && (
            <>
              <span className="text-muted-foreground/40">/</span>
              {(() => {
                const browseUrl = remoteUrlToBrowseUrl(remoteUrl);
                const Icon = remoteUrl.includes('github.com') ? Github : Globe;
                const content = (
                  <>
                    <Icon className="h-5 w-5 shrink-0" />
                    <span className="truncate font-medium">{formatRemoteUrl(remoteUrl)}</span>
                  </>
                );
                return browseUrl ? (
                  <a
                    href={browseUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex h-9 shrink-0 items-center gap-1.5 truncate rounded px-2 py-1 transition-colors hover:bg-muted hover:text-foreground"
                    data-testid="new-thread-repo-link"
                    title={browseUrl}
                  >
                    {content}
                  </a>
                ) : (
                  <span className="flex h-9 shrink-0 items-center gap-1.5 truncate px-2 py-1">
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
                <span className="flex h-9 items-center gap-1.5 px-2 py-1">
                  <GitBranch className="h-5 w-5 shrink-0" />
                  <Loader2 className="h-5 w-5 animate-spin" />
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
                  triggerClassName="flex h-9 max-w-[300px] items-center gap-1.5 truncate rounded px-2 py-1 text-base text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none [&_svg]:h-5 [&_svg]:w-5"
                />
              )}
            </>
          )}
        </div>
        {issueContext && (
          <div
            className="mb-1.5 flex items-center gap-1.5 rounded-md border border-emerald-500/20 bg-emerald-500/5 px-2 py-1 text-xs"
            data-testid="issue-context-banner"
          >
            <CircleDot className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
            <span className="truncate text-muted-foreground">
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
            className="mb-1.5 flex items-center gap-1.5 text-[10px] text-muted-foreground/60"
            data-testid="worktree-preview"
          >
            <GitFork className="h-3 w-3 shrink-0" />
            <span className="truncate font-mono">{previewBranch}</span>
          </div>
        )}
        <PromptInput
          key={issueContext ? `${effectiveProjectId}-issue` : effectiveProjectId}
          onSubmit={handleCreate}
          loading={creating}
          isNewThread
          showBacklog
          projectId={effectiveProjectId || undefined}
          initialPrompt={issueContext?.prompt}
          onContentChange={handleContentChange}
          onWorktreeModeChange={setIsWorktreeMode}
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
