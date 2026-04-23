import type { ThreadPurpose } from '@funny/shared';
import { DEFAULT_THREAD_MODE } from '@funny/shared/models';
import { CircleDot, FolderOpen, GitBranch, GitFork, Globe, Github, Loader2 } from 'lucide-react';
import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { useBranchSwitch } from '@/hooks/use-branch-switch';
import { useNavigationBlock } from '@/hooks/use-navigation-block';
import { api } from '@/lib/api';
import { toastError } from '@/lib/toast-error';
import { buildPath } from '@/lib/url';
import { useBranchPickerStore } from '@/stores/branch-picker-store';
import { useProjectStore } from '@/stores/project-store';
import { useSettingsStore, deriveToolLists } from '@/stores/settings-store';
import { useThreadStore } from '@/stores/thread-store';
import { useUIStore } from '@/stores/ui-store';

import { PromptInput } from '../PromptInput';
import { formatRemoteUrl } from '../PromptInputUI';
import { BranchPicker } from '../SearchablePicker';
import { SaveBacklogDialog } from './SaveBacklogDialog';

/** Generate a kebab-case arc name from a prompt with a short unique suffix. */
function generateArcName(prompt: string): string {
  const slug =
    prompt
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 32)
      .replace(/-$/, '') || 'unnamed-arc';
  const suffix = Math.random().toString(36).slice(2, 6);
  return `${slug}-${suffix}`;
}

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

export function NewThreadInput() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const newThreadProjectId = useUIStore((s) => s.newThreadProjectId);
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId);
  const effectiveProjectId = newThreadProjectId || selectedProjectId;
  const newThreadIdleOnly = useUIStore((s) => s.newThreadIdleOnly);
  const issueContext = useUIStore((s) => s.newThreadIssueContext);
  const clearIssueContext = useUIStore((s) => s.clearIssueContext);
  const cancelNewThread = useUIStore((s) => s.cancelNewThread);
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
      branchPickerSetSelected(branch);
      // Checkout immediately so the ReviewPane can show the correct branch status.
      // ensureBranch is a no-op if already on the target branch.
      if (effectiveProjectId && branch !== branchPickerCurrentBranch) {
        await ensureBranch(effectiveProjectId, branch);
      }
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
  const [savingBacklog, setSavingBacklog] = useState(false);
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

  // Block navigation when the editor has unsaved content
  const blocker = useNavigationBlock((currentPath, nextPath) => {
    if (justSubmittedRef.current) return false;
    if (currentPath === nextPath) return false;
    return hasContentRef.current;
  });

  const handleSaveToBacklog = useCallback(async () => {
    if (!effectiveProjectId) return;
    const text = latestPromptTextRef.current.trim();
    if (!text) {
      blocker.proceed?.();
      return;
    }
    setSavingBacklog(true);
    const result = await api.createIdleThread({
      projectId: effectiveProjectId,
      title: text.slice(0, 200),
      mode: defaultThreadMode,
      prompt: text,
    });
    setSavingBacklog(false);
    if (result.isErr()) {
      toastError(result.error, 'createThread');
      return;
    }
    await loadThreadsForProject(effectiveProjectId);
    toast.success(t('toast.threadCreated', { title: text.slice(0, 200) }));
    blocker.proceed?.();
  }, [effectiveProjectId, defaultThreadMode, loadThreadsForProject, blocker, t]);

  const handleDiscard = useCallback(() => {
    blocker.proceed?.();
  }, [blocker]);

  const handleCancel = useCallback(() => {
    blocker.reset?.();
  }, [blocker]);

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
      purpose?: ThreadPurpose;
      agentTemplateId?: string;
      templateVariables?: Record<string, string>;
    },
    images?: any[],
  ): Promise<boolean> => {
    if (!effectiveProjectId || creating) return false;
    setCreating(true);

    const purpose = opts.purpose ?? 'implement';
    const isLocalOnlyPurpose = purpose !== 'implement';
    const threadMode = isLocalOnlyPurpose
      ? 'local'
      : (opts.threadMode as 'local' | 'worktree') || defaultThreadMode;

    // Auto-create arc for explore purpose
    let arcId: string | undefined;
    if (purpose === 'explore') {
      const arcName = generateArcName(prompt);
      const arcResult = await api.createArc(effectiveProjectId, arcName);
      if (arcResult.isErr()) {
        toastError(arcResult.error, 'createArc');
        setCreating(false);
        return false;
      }
      arcId = arcResult.value.id;
      // Create arc directory on filesystem
      await api.createArcDirectory(effectiveProjectId, arcName);
    }

    // If idle-only mode or sendToBacklog toggle, create idle thread without executing
    if (newThreadIdleOnly || opts.sendToBacklog) {
      const result = await api.createIdleThread({
        projectId: effectiveProjectId,
        title: prompt.slice(0, 200),
        mode: threadMode,
        baseBranch: opts.baseBranch,
        prompt,
        images,
        arcId,
        purpose,
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
      cancelNewThread();
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
      permissionMode: isLocalOnlyPurpose ? 'plan' : opts.mode,
      effort: opts.effort,
      baseBranch: opts.baseBranch,
      prompt,
      images,
      allowedTools,
      disallowedTools,
      fileReferences: opts.fileReferences,
      symbolReferences: opts.symbolReferences,
      arcId,
      purpose,
      agentTemplateId: opts.agentTemplateId,
      templateVariables: opts.templateVariables,
    });

    if (result.isErr()) {
      toastError(result.error, 'createThread');
      setCreating(false);
      return false;
    }

    // Thread created — skip the blocker and navigate immediately
    justSubmittedRef.current = true;
    useThreadStore.setState({ selectedThreadId: result.value.id });
    setCreating(false);
    setReviewPaneOpen(false);
    cancelNewThread();
    navigate(buildPath(`/projects/${effectiveProjectId}/threads/${result.value.id}`));
    loadThreadsForProject(effectiveProjectId);
    return true;
  };

  return (
    <div className="flex flex-1 items-center justify-center px-4 text-muted-foreground">
      <div className="w-full max-w-3xl">
        {project && (
          <h1
            className="mb-3 truncate text-3xl font-semibold text-foreground"
            data-testid="new-thread-project-name"
            title={project.name}
          >
            {project.name}
          </h1>
        )}
        {/* Context bar: Project / Repo / Branch */}
        <div
          className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground"
          data-testid="new-thread-context-bar"
        >
          {project && (
            <span className="flex shrink-0 items-center gap-1">
              <FolderOpen className="icon-xs shrink-0" />
              <span className="truncate font-medium">{project.name}</span>
            </span>
          )}
          {project && remoteUrl && (
            <>
              <span className="text-muted-foreground/40">/</span>
              <span className="flex shrink-0 items-center gap-1 truncate">
                {remoteUrl.includes('github.com') ? (
                  <Github className="icon-xs shrink-0" />
                ) : (
                  <Globe className="icon-xs shrink-0" />
                )}
                <span className="truncate font-medium">{formatRemoteUrl(remoteUrl)}</span>
              </span>
            </>
          )}
          {(branchPickerBranches.length > 0 || branchPickerLoading) && (
            <>
              <span className="text-muted-foreground/40">/</span>
              {branchPickerLoading ? (
                <span className="flex items-center gap-1 px-2 py-1">
                  <GitBranch className="icon-xs shrink-0" />
                  <Loader2 className="icon-xs animate-spin" />
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
