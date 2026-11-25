import type { Project } from '@funny/shared';
import { DEFAULT_PROVIDER } from '@funny/shared/models';
import type { TFunction } from 'i18next';
import { useState, useCallback, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';

import { useProjects } from '@/data/projects/hooks';
import { useProjectThreadMode } from '@/data/runner/hooks';
import { useSaveBacklogOnLeave } from '@/hooks/use-save-backlog-on-leave';
import { useStableCallback } from '@/hooks/use-stable-callback';
import { useThreadCreation } from '@/hooks/use-thread-creation';
import { api } from '@/lib/api';
import { getThreadRoute } from '@/lib/thread-variant';
import { buildPath } from '@/lib/url';
import { whilePending } from '@/lib/while-pending';
import {
  buildWorkflowRunBody,
  parseWorkflowInvocation,
  type WorkflowInvocation,
} from '@/lib/workflow-invocation';
import { useProjectStore } from '@/stores/project-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useThreadStore } from '@/stores/thread-store';
import { useUIStore } from '@/stores/ui-store';

import { AvailableMcpServers } from '../AvailableMcpServers';
import { PromptInput } from '../PromptInput';
import {
  IssueContextBanner,
  NewThreadCreatingView,
  ScratchComposeView,
} from './NewThreadComposeViews';
import { NewThreadContextBar } from './NewThreadContextBar';
import { SaveBacklogDialog } from './SaveBacklogDialog';
import { type PreparationMessageMetadata } from './ThreadPreparationView';

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

/**
 * State plus a ref holding the same initial value. Callers write the ref next
 * to the state, for async callbacks that may close over a stale render.
 */
function useStateWithRef<T>(initial: T) {
  const [value, setValue] = useState(initial);
  const ref = useRef(initial);
  return [value, setValue, ref] as const;
}

/**
 * Whether the user left this compose form (e.g. Alt+N remounts it) while a
 * create was still in flight. The thread is still created and listed, but
 * opening it would yank the user out of whatever they moved on to. Embedded
 * callers (`onCreated`) still want the id after closing the form, so they
 * never count as abandoned.
 */
function useComposeAttempt(onCreated: NewThreadInputProps['onCreated']) {
  const abandonedRef = useRef(false);
  useEffect(() => {
    abandonedRef.current = false;
    return () => {
      abandonedRef.current = true;
    };
  }, []);
  return useCallback(() => abandonedRef.current && !onCreated, [onCreated]);
}

/**
 * Mirrors the composer's worktree toggle for the branch preview: the user's
 * choice once they flip it, else the runtime row's default (which may still be
 * loading on the first render).
 */
function useWorktreePreview(defaultThreadMode: string): [boolean, (enabled: boolean) => void] {
  const [choice, setChoice] = useState<boolean | null>(null);
  return [choice ?? defaultThreadMode === 'worktree', setChoice];
}

export function NewThreadInput({
  projectIdOverride,
  isScratchOverride,
  onCreated,
  onCancel,
}: NewThreadInputProps = {}) {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const {
    newThreadIsScratch,
    effectiveProjectId,
    project,
    defaultThreadMode,
    projectPath,
    defaultProvider,
  } = useComposeProject(projectIdOverride, isScratchOverride);
  const newThreadIdleOnly = useUIStore((s) => s.newThreadIdleOnly);
  const addScratchThread = useThreadStore((s) => s.addScratchThread);
  const activeDesignId = useUIStore((s) => s.activeDesignId);
  const issueContext = useUIStore((s) => s.newThreadIssueContext);
  const clearIssueContext = useUIStore((s) => s.clearIssueContext);
  const initialPrefill = useComposePrefill();
  const cancelNewThreadGlobal = useUIStore((s) => s.cancelNewThread);
  const cancelNewThread = onCancel ?? cancelNewThreadGlobal;
  const setReviewPaneOpen = useUIStore((s) => s.setReviewPaneOpen);
  const loadThreadsForProject = useThreadStore((s) => s.loadThreadsForProject);
  const toolPermissions = useSettingsStore((s) => s.toolPermissions);

  // ── Project path (for AvailableMcpServers) ──
  const [mcpProvider, setMcpProvider] = useMcpProvider(defaultProvider);

  // ── Worktree preview ──
  const [previewBranch, setPreviewBranch] = useState<string | null>(null);
  const [isWorktreeMode, setIsWorktreeMode] = useWorktreePreview(defaultThreadMode);

  // ── Save-to-backlog guard ──
  const { hasContentRef, latestPromptTextRef, handleContentChange } = useComposeContent(
    project?.name,
    setPreviewBranch,
  );
  // Skip blocking when the user just submitted (created a thread successfully)
  const justSubmittedRef = useRef(false);

  const { blocker, savingBacklog, handleSaveToBacklog, handleDiscard, handleCancel } =
    useSaveBacklogOnLeave({
      effectiveProjectId: effectiveProjectId ?? undefined,
      defaultThreadMode,
      latestPromptTextRef,
      hasContentRef,
      justSubmittedRef,
    });

  const [restoredPrompt, setRestoredPrompt] = useState<string | null>(null);
  // The refs are read by the async onSuccess callback, which may close over a
  // stale render.
  const [submittedPrompt, setSubmittedPrompt, submittedPromptRef] = useStateWithRef('');
  const [submittedMetadata, setSubmittedMetadata, submittedMetadataRef] = useStateWithRef<
    PreparationMessageMetadata | undefined
  >(undefined);
  // Pin the "Preparing…" loader from a successful submit until this component
  // unmounts via the navigation onSuccess triggers. The hook flips its local
  // `creating` flag back to false as soon as onSuccess resolves, but react-
  // router's URL commit (which is what unmounts this compose form) lands a
  // render later than that flip + the synchronous `cancelNewThread()` store
  // update. Without this pin there is a one-commit window where ThreadView
  // still renders the compose form with `creating === false`, flashing the
  // empty new-thread screen between "Preparing…" and the thread view.
  const [submitted, setSubmitted] = useState(false);
  const [workflowSubmitting, setWorkflowSubmitting] = useState(false);
  const [requestPending, setRequestPending] = useState(false);
  const isAbandoned = useComposeAttempt(onCreated);

  const handleThreadCreated = useCallback(
    async (threadId: string, kind: 'scratch' | 'idle' | 'normal', thread: any) => {
      // justSubmittedRef tells the unsaved-prompt guard to let the navigate
      // through. Only scratch + normal navigate; idle stays in place.
      if (kind === 'scratch' || kind === 'normal') {
        justSubmittedRef.current = true;
      }
      if (!isAbandoned()) setReviewPaneOpen(false);

      if (kind === 'scratch') {
        addScratchThread(thread);
      } else {
        // Idle + normal both refresh the project's thread list.
        await refreshCreatedProject(effectiveProjectId, kind, loadThreadsForProject);
      }
      if (isAbandoned()) return;

      if (kind === 'idle') {
        toast.success(t('toast.sentToBacklog', { title: thread?.title ?? '' }));
        if (onCreated) {
          onCreated(threadId);
        } else {
          cancelNewThread();
        }
        return;
      }

      finishCreatedThread(
        threadId,
        onCreated,
        cancelNewThread,
        navigate,
        createdThreadPath(kind, threadId, thread, effectiveProjectId, activeDesignId),
        {
          pendingPrompt: submittedPromptRef.current,
          pendingMetadata: submittedMetadataRef.current,
        },
      );
    },
    [
      activeDesignId,
      addScratchThread,
      cancelNewThread,
      effectiveProjectId,
      isAbandoned,
      loadThreadsForProject,
      navigate,
      onCreated,
      setReviewPaneOpen,
      t,
      submittedPromptRef,
      submittedMetadataRef,
    ],
  );

  const { creating, createThread: createThreadFromHook } = useThreadCreation({
    projectId: newThreadIsScratch ? null : (effectiveProjectId ?? null),
    defaultThreadMode,
    toolPermissions,
    isScratch: newThreadIsScratch,
    forceIdle: newThreadIdleOnly,
    designId: activeDesignId ?? undefined,
    onSuccess: handleThreadCreated,
  });

  const handleCreate = useCallback(
    async (
      prompt: string,
      opts: Parameters<typeof createThreadFromHook>[1],
      images?: any[],
    ): Promise<boolean> => {
      const metadata: PreparationMessageMetadata = {
        model: opts.model as PreparationMessageMetadata['model'],
        permissionMode: opts.mode as PreparationMessageMetadata['permissionMode'],
        effort: opts.effort as PreparationMessageMetadata['effort'],
        timestamp: new Date().toISOString(),
        images,
      };
      setSubmittedMetadata(metadata);
      submittedMetadataRef.current = metadata;
      const workflowParse = parseWorkflowInvocation(prompt);
      if (!workflowParse.ok) {
        toast.error(workflowParse.error);
        return false;
      }
      const { invocation } = workflowParse;
      if (invocation) {
        if (newThreadIsScratch || !effectiveProjectId) {
          toast.error('Workflows require a project thread.');
          return false;
        }

        setRestoredPrompt(null);
        setSubmittedPrompt(prompt);
        submittedPromptRef.current = prompt;
        return whilePending(setWorkflowSubmitting, () =>
          createWorkflowThread({
            invocation,
            prompt,
            opts,
            images,
            projectId: effectiveProjectId,
            defaultThreadMode,
            designId: activeDesignId,
            t,
            setRestoredPrompt,
            onThreadCreated: handleThreadCreated,
          }),
        );
      }

      // Reset restored-prompt before the call so the field clears if it succeeds.
      setRestoredPrompt(null);
      setSubmittedPrompt(prompt);
      submittedPromptRef.current = prompt;
      setRequestPending(true);
      const ok = await createThreadFromHook(prompt, opts, images).finally(() => {
        setRequestPending(false);
      });
      if (!ok) {
        // Restore the user's text so they don't lose it on a failed submit.
        setRestoredPrompt(prompt);
        return ok;
      }
      // Only pin the loader when onSuccess will navigate away (and thus unmount
      // this component). Idle threads and design-view creates stay on this
      // screen, so pinning there would strand the loader forever. Mirrors the
      // navigation conditions in onSuccess above.
      // "Send to backlog" creates an idle thread just like idle-only mode:
      // it stays on this screen (toast only), so it must not pin the loader.
      const willNavigateAway = shouldNavigateAfterCreate(
        !!onCreated,
        newThreadIdleOnly,
        opts.sendToBacklog === true,
        newThreadIsScratch,
        !!activeDesignId,
      );
      if (willNavigateAway) setSubmitted(true);
      return ok;
    },
    [
      activeDesignId,
      createThreadFromHook,
      defaultThreadMode,
      effectiveProjectId,
      handleThreadCreated,
      newThreadIdleOnly,
      newThreadIsScratch,
      onCreated,
      t,
      setSubmittedPrompt,
      setSubmittedMetadata,
      submittedPromptRef,
      submittedMetadataRef,
    ],
  );

  if (creating || requestPending || submitted || workflowSubmitting) {
    return (
      <NewThreadCreatingView
        prompt={submittedPrompt}
        metadata={submittedMetadata}
        projectId={effectiveProjectId || undefined}
      />
    );
  }

  if (newThreadIsScratch) {
    // The handleCreate() branch above routes to api.createScratchThread().
    return (
      <ScratchComposeView
        onSubmit={handleCreate}
        loading={creating}
        onContentChange={handleContentChange}
        initialPrompt={restoredPrompt ?? undefined}
      />
    );
  }

  // Context bar content (project / repo / branch, plus the new worktree's
  // branch name in worktree mode) — rendered by the prompt input at the top,
  // next to the worktree switch. Shared with the kanban "Add thread" dialog
  // (SlideUpPrompt) via NewThreadContextBar.
  const contextBar = (
    <NewThreadContextBar
      projectId={effectiveProjectId || undefined}
      worktreeBranch={isWorktreeMode ? previewBranch : null}
    />
  );

  return (
    <div className="text-muted-foreground flex flex-1 items-center justify-center px-4">
      <div className="w-full max-w-3xl">
        {issueContext && (
          <IssueContextBanner title={issueContext.title} onDismiss={clearIssueContext} />
        )}
        <PromptInput
          key={composePromptKey(effectiveProjectId, !!issueContext, initialPrefill)}
          onSubmit={handleCreate}
          loading={creating}
          isNewThread
          showBacklog
          newThreadContextBar={contextBar}
          projectId={effectiveProjectId || undefined}
          initialPrompt={issueContext?.prompt ?? initialPrefill ?? restoredPrompt ?? undefined}
          onContentChange={handleContentChange}
          onWorktreeModeChange={setIsWorktreeMode}
          onProviderChange={setMcpProvider}
        />
        <AvailableMcpServers
          projectPath={projectPath || undefined}
          projectId={effectiveProjectId || undefined}
          provider={mcpProvider}
        />
      </div>

      <SaveBacklogDialog
        open={blocker.state === 'blocked'}
        loading={savingBacklog}
        onSave={handleSaveToBacklog}
        onDiscard={handleDiscard}
        onCancel={handleCancel}
      />
    </div>
  );
}

async function refreshCreatedProject(
  projectId: string | null | undefined,
  kind: 'idle' | 'normal',
  load: (projectId: string) => Promise<void>,
) {
  if (!projectId) return;
  const refresh = load(projectId);
  if (kind === 'idle') await refresh;
  else
    void refresh.catch(() => {
      /* Sidebar refresh must not block opening the new thread. */
    });
}

function composePromptKey(
  projectId: string | null | undefined,
  fromIssue: boolean,
  prefill: string | null | undefined,
) {
  if (fromIssue) return `${projectId}-issue`;
  return prefill ? `${projectId}-prefill-${prefill.length}` : projectId;
}
function shouldNavigateAfterCreate(
  hasCallback: boolean,
  idleOnly: boolean,
  sendToBacklog: boolean,
  scratch: boolean,
  hasDesign: boolean,
) {
  return !hasCallback && !idleOnly && !sendToBacklog && (scratch || !hasDesign);
}

/** Where a created scratch or normal thread opens; `undefined` stays in place. */
function createdThreadPath(
  kind: 'scratch' | 'normal',
  threadId: string,
  thread: Parameters<typeof getThreadRoute>[0],
  projectId: string | null | undefined,
  designId: string | null | undefined,
) {
  if (kind === 'scratch') return buildPath(getThreadRoute(thread));
  return !designId && projectId
    ? buildPath(`/projects/${projectId}/threads/${threadId}`)
    : undefined;
}

function finishCreatedThread(
  threadId: string,
  onCreated: ((id: string) => void) | undefined,
  cancel: () => void,
  navigate: ReturnType<typeof useNavigate>,
  path: string | undefined,
  state: { pendingPrompt: string; pendingMetadata?: PreparationMessageMetadata },
) {
  if (onCreated) {
    onCreated(threadId);
    return;
  }
  useThreadStore.setState({ selectedThreadId: threadId });
  cancel();
  if (path) navigate(path, { state });
}

function useComposeProject(
  projectIdOverride: string | undefined,
  isScratchOverride: boolean | undefined,
) {
  const newThreadProjectId = useUIStore((s) => s.newThreadProjectId);
  const newThreadIsScratchStore = useUIStore((s) => s.newThreadIsScratch);
  const newThreadIsScratch = isScratchOverride ?? newThreadIsScratchStore;
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId);
  const effectiveProjectId = projectIdOverride || newThreadProjectId || selectedProjectId;
  const projects = useProjects();
  const project = effectiveProjectId
    ? projects.find((p) => p.id === effectiveProjectId)
    : undefined;
  // Local/worktree comes from the caller's runtime row (project-runtime-settings).
  const defaultThreadMode = useProjectThreadMode(effectiveProjectId);
  return {
    newThreadIsScratch,
    effectiveProjectId,
    project,
    ...composeProjectDefaults(project),
    defaultThreadMode,
  };
}

function composeProjectDefaults(project: Project | undefined) {
  // The thread mode comes from the caller's runtime row (project-runtime-settings),
  // resolved by the hook above; it is not a project-level default.
  return {
    projectPath: project?.path ?? '',
    defaultProvider: project?.defaultProvider ?? DEFAULT_PROVIDER,
  };
}

/**
 * Tracks the prompt's content for the unsaved-prompt guard and updates the
 * worktree preview branch name (mirrors server-side naming).
 */
function useComposeContent(
  projectName: string | undefined,
  setPreviewBranch: (branch: string | null) => void,
) {
  const hasContentRef = useRef(false);
  const latestPromptTextRef = useRef('');
  const handleContentChange = useCallback(
    (hasContent: boolean, text: string) => {
      hasContentRef.current = hasContent;
      latestPromptTextRef.current = text;
      // Update worktree preview branch name (mirrors server-side naming)
      if (hasContent && text.trim()) {
        const projectSlug = slugifyTitle(projectName || 'project');
        const titleSlug = slugifyTitle(text.slice(0, 200));
        setPreviewBranch(`${projectSlug}/${titleSlug}-xxxxxx`);
      } else {
        setPreviewBranch(null);
      }
    },
    [projectName, setPreviewBranch],
  );
  return { hasContentRef, latestPromptTextRef, handleContentChange };
}

/**
 * One-shot: capture the prefill at mount time, then clear it from the store
 * so it doesn't bleed into the next compose. The captured value is what
 * gets passed to PromptInput as initialPrompt.
 */
function useComposePrefill() {
  const composePrefillPrompt = useUIStore((s) => s.composePrefillPrompt);
  const setComposePrefillPrompt = useUIStore((s) => s.setComposePrefillPrompt);
  // Captured once: the store entry is cleared right after mount.
  const [initialPrefill] = useState(composePrefillPrompt);
  const clearComposePrefill = useStableCallback(() => {
    if (composePrefillPrompt !== null) setComposePrefillPrompt(null);
  });
  // Run once at mount; do NOT re-run when the store value flips back to null.
  useEffect(() => {
    clearComposePrefill();
  }, [clearComposePrefill]);
  return initialPrefill;
}

/** The provider whose MCP servers are listed; follows the project default when it changes. */
function useMcpProvider(defaultProvider: string) {
  const [mcpProvider, setMcpProvider] = useState(defaultProvider);

  // Follow the default provider when it changes, without an extra effect pass.
  const [seenDefaultProvider, setSeenDefaultProvider] = useState(defaultProvider);
  if (seenDefaultProvider !== defaultProvider) {
    setSeenDefaultProvider(defaultProvider);
    setMcpProvider(defaultProvider);
  }
  return [mcpProvider, setMcpProvider] as const;
}

type CreateThreadOpts = Parameters<ReturnType<typeof useThreadCreation>['createThread']>[1];

/** Creates an idle thread for a workflow invocation and starts the workflow on it. */
async function createWorkflowThread({
  invocation,
  prompt,
  opts,
  images,
  projectId,
  defaultThreadMode,
  designId,
  t,
  setRestoredPrompt,
  onThreadCreated,
}: {
  invocation: WorkflowInvocation;
  prompt: string;
  opts: CreateThreadOpts;
  images: any[] | undefined;
  projectId: string;
  defaultThreadMode: 'local' | 'worktree';
  designId: string | null | undefined;
  t: TFunction;
  setRestoredPrompt: (prompt: string | null) => void;
  onThreadCreated: (threadId: string, kind: 'normal', thread: any) => Promise<void>;
}): Promise<boolean> {
  const workflowPrompt = invocation.prompt ?? `Run workflow ${invocation.workflowName}`;
  const createResult = await api.createIdleThread({
    projectId,
    title: workflowPrompt.slice(0, 200),
    mode: (opts.threadMode as 'local' | 'worktree') || defaultThreadMode,
    baseBranch: opts.baseBranch,
    prompt: workflowPrompt,
    images,
    designId: designId || undefined,
  });

  if (createResult.isErr()) {
    toast.error(createResult.error.message);
    setRestoredPrompt(prompt);
    return false;
  }

  const runResult = await api.runWorkflow(invocation.workflowName, {
    threadId: createResult.value.id,
    ...buildWorkflowRunBody(invocation, {
      fileReferences: opts.fileReferences,
      symbolReferences: opts.symbolReferences,
    }),
  });

  if (runResult.isErr()) toast.error(runResult.error.message);
  else toast.success(t('workflows.started', { defaultValue: 'Workflow started' }));

  await onThreadCreated(createResult.value.id, 'normal', createResult.value);
  return true;
}
