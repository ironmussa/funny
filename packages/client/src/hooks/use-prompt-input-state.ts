import type { AgentProvider, ImageAttachment, PermissionMode, QueuedMessage } from '@funny/shared';
import {
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  DEFAULT_PERMISSION_MODE,
  DEFAULT_THREAD_MODE,
  type AgentModel,
  getModelContextWindow,
} from '@funny/shared/models';
import type { WorkflowSummary } from '@funny/shared/types/workflows';
import { useState, useRef, useEffect, useCallback, useMemo, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import type { PromptEditorHandle } from '@/components/prompt-editor/PromptEditor';
import { useBranchSwitch } from '@/hooks/use-branch-switch';
import { useDictation } from '@/hooks/use-dictation';
import { usePushToTalk } from '@/hooks/use-push-to-talk';
import { useSlashSkills } from '@/hooks/use-slash-skills';
import { useUnifiedPromptModelGroups } from '@/hooks/use-unified-prompt-model-groups';
import { api } from '@/lib/api';
import { createClientLogger } from '@/lib/client-logger';
import { getEffortLevels, filterVisibleModelGroups, parseUnifiedModel } from '@/lib/providers';
import { toastError } from '@/lib/toast-error';
import { resolveThreadBranch } from '@/lib/utils';
import { useBranchPickerStore } from '@/stores/branch-picker-store';
import { useDraftStore } from '@/stores/draft-store';
import { useGitStatusForThread } from '@/stores/git-status-store';
import { useProfileStore } from '@/stores/profile-store';
import { useProjectStore } from '@/stores/project-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useThreadId, useThreadSelector } from '@/stores/thread-context';
import * as mutations from '@/stores/thread-mutations';
import { useThreadStore } from '@/stores/thread-store';
import { useUIStore } from '@/stores/ui-store';

const queueLog = createClientLogger('PromptInputQueue');

// Stable empty default so threads without an init payload don't churn the editor.
const EMPTY_SLASH_COMMANDS: string[] = [];
const EMPTY_QUEUED_MESSAGES: QueuedMessage[] = [];
const EMPTY_WORKFLOW_SUGGESTIONS: WorkflowSummary[] = [];

export type SubmitOpts = {
  provider?: string;
  model: string;
  mode: string;
  effort?: string;
  threadMode?: string;
  runtime?: string;
  baseBranch?: string;
  cwd?: string;
  sendToBacklog?: boolean;
  fileReferences?: { path: string; type?: 'file' | 'folder' }[];
  symbolReferences?: {
    path: string;
    name: string;
    kind: string;
    line: number;
    endLine?: number;
  }[];
};

export type SubmitFn = (
  prompt: string,
  opts: SubmitOpts,
  images?: ImageAttachment[],
) => Promise<boolean | void> | boolean | void;

export interface ThreadOverride {
  provider?: AgentProvider | null;
  model?: AgentModel | null;
  permissionMode?: string | null;
  branch?: string | null;
  baseBranch?: string | null;
  worktreePath?: string | null;
  contextUsage?: { cumulativeInputTokens?: number } | null;
  queuedCount?: number | null;
  projectId?: string | null;
}

interface UsePromptInputStateArgs {
  onSubmit: SubmitFn;
  onContentChange?: (hasContent: boolean, text: string) => void;
  onWorktreeModeChange?: (enabled: boolean) => void;
  onProviderChange?: (provider: string) => void;
  loading: boolean;
  running: boolean;
  queuedCountProp: number;
  queuedNextMessageProp?: string;
  isNewThread: boolean;
  propProjectId?: string;
  initialPromptProp?: string;
  threadOverride?: ThreadOverride;
}

/**
 * Aggregates the eight stores/hooks/lib helpers and ~13 useStates that drive
 * PromptInput, plus the dictation/PTT effect, branch fetching, queue lifecycle,
 * draft persistence, and skill loading. PromptInput.tsx imports this single
 * hook instead of wiring all the moving pieces by hand.
 */
export function usePromptInputState({
  onSubmit,
  onContentChange,
  onWorktreeModeChange,
  onProviderChange,
  loading,
  running,
  queuedCountProp,
  queuedNextMessageProp,
  isNewThread,
  propProjectId,
  initialPromptProp,
  threadOverride,
}: UsePromptInputStateArgs) {
  const { t } = useTranslation();

  // Read queuedCount via context — single-thread view resolves to activeThread,
  // grid columns resolve to their column-local thread.
  //
  // Source of truth: `queuedCountByThread` (persistent across thread switches
  // and payload unloads). Payload-level `queuedCount` is only updated when the
  // thread is hydrated in `threadDataById`, so a `queue:update` for a thread
  // that was unloaded would silently drop. The persistent map always reflects
  // the latest server state.
  const contextThreadId = useThreadId();
  const effectiveThreadId = contextThreadId;
  const storeQueuedCount = useThreadStore((s) =>
    effectiveThreadId
      ? (s.queuedCountByThread[effectiveThreadId] ??
        s.threadDataById[effectiveThreadId]?.queuedCount ??
        0)
      : 0,
  );
  const queuedCount =
    storeQueuedCount > 0 ? storeQueuedCount : (threadOverride?.queuedCount ?? queuedCountProp);
  const cachedQueuedMessages = useThreadStore((s) =>
    effectiveThreadId
      ? (s.queuedMessagesByThread[effectiveThreadId] ?? EMPTY_QUEUED_MESSAGES)
      : EMPTY_QUEUED_MESSAGES,
  );
  const storeQueuedNextMessage = useThreadStore((s) =>
    effectiveThreadId
      ? (s.queuedNextMessageByThread[effectiveThreadId] ??
        s.threadDataById[effectiveThreadId]?.queuedNextMessage)
      : undefined,
  );
  const queuedNextMessage = storeQueuedNextMessage ?? queuedNextMessageProp;

  // ── Project defaults ──
  const projects = useProjectStore((s) => s.projects);
  const selectedProjectIdForDefaults = useProjectStore((s) => s.selectedProjectId);
  // For an existing thread, the project is the thread's OWN project — not the
  // globally-selected one. This matters in the live-columns grid, where each
  // column renders its own PromptInput for a different thread (and possibly a
  // different project) while the global selection points elsewhere. Falling
  // back to the global selection there left `effectiveProject` undefined, so
  // the powerline lost its project segment and rendered a gray branch-only bar.
  // New threads still resolve from the selected/prop project.
  const storeThreadProjectId = useThreadSelector((t) => t?.projectId);
  const threadProjectId = threadOverride?.projectId ?? storeThreadProjectId;
  const resolvedProjectId =
    (!isNewThread && threadProjectId) || propProjectId || selectedProjectIdForDefaults;
  const effectiveProject = resolvedProjectId
    ? projects.find((p) => p.id === resolvedProjectId)
    : undefined;
  const defaultProvider = effectiveProject?.defaultProvider ?? DEFAULT_PROVIDER;
  const defaultModel = effectiveProject?.defaultModel ?? DEFAULT_MODEL;
  const defaultPermissionMode = effectiveProject?.defaultPermissionMode ?? DEFAULT_PERMISSION_MODE;
  const defaultThreadMode = effectiveProject?.defaultMode ?? DEFAULT_THREAD_MODE;

  const editorRef = useRef<PromptEditorHandle>(null);

  // ── Model & mode state ──
  const [unifiedModel, setUnifiedModelRaw] = useState<string>(`${defaultProvider}:${defaultModel}`);
  const [mode, setMode] = useState<string>(defaultPermissionMode);
  const modeMutationRef = useRef(0);
  const [createWorktree, setCreateWorktreeRaw] = useState(defaultThreadMode === 'worktree');
  const setCreateWorktree = useCallback(
    (v: boolean) => {
      setCreateWorktreeRaw(v);
      onWorktreeModeChange?.(v);
    },
    [onWorktreeModeChange],
  );
  const [runtime, setRuntime] = useState<'local' | 'remote'>('local');
  const hasLauncher = !!effectiveProject?.launcherUrl;
  const [effort, setEffort] = useState<string>('high');

  const baseUnifiedModelGroups = useUnifiedPromptModelGroups();
  const hiddenPromptModels = useSettingsStore((s) => s.hiddenPromptModels);
  const unifiedModelGroups = useMemo(
    () => filterVisibleModelGroups(baseUnifiedModelGroups, hiddenPromptModels, unifiedModel),
    [baseUnifiedModelGroups, hiddenPromptModels, unifiedModel],
  );

  const { provider: currentProvider, model: currentModel } = useMemo(
    () => parseUnifiedModel(unifiedModel),
    [unifiedModel],
  );
  const lastNotifiedProviderRef = useRef<string | undefined>(undefined);
  const notifyProviderChange = useCallback(
    (nextProvider: string) => {
      if (lastNotifiedProviderRef.current === nextProvider) return;
      lastNotifiedProviderRef.current = nextProvider;
      onProviderChange?.(nextProvider);
    },
    [onProviderChange],
  );
  useEffect(() => {
    notifyProviderChange(currentProvider);
  }, [currentProvider, notifyProviderChange]);
  const setUnifiedModel = useCallback(
    (nextUnifiedModel: string) => {
      const nextProvider = parseUnifiedModel(nextUnifiedModel).provider;
      if (nextProvider !== currentProvider) {
        notifyProviderChange(nextProvider);
      }
      setUnifiedModelRaw(nextUnifiedModel);
    },
    [currentProvider, notifyProviderChange],
  );
  const effortOptions = useMemo(
    () => getEffortLevels(currentModel, currentProvider),
    [currentProvider, currentModel],
  );
  const modes = useMemo(() => {
    const baseModes = [
      { value: 'ask', label: t('prompt.ask') },
      { value: 'plan', label: t('prompt.plan') },
      { value: 'autoEdit', label: t('prompt.autoEdit') },
      { value: 'confirmEdit', label: t('prompt.askBeforeEdits') },
    ];
    if (currentProvider === 'claude') {
      baseModes.splice(2, 0, { value: 'auto', label: t('prompt.auto') });
    }
    return baseModes;
  }, [t, currentProvider]);

  // ── Active thread state (resolved via context) ──
  const storeActiveThreadPermissionMode = useThreadSelector((t) => t?.permissionMode);
  const activeThreadPermissionMode =
    threadOverride?.permissionMode ?? storeActiveThreadPermissionMode;
  const updateThreadPermissionMode = useThreadStore((s) => s.updateThreadPermissionMode);
  const storeActiveThreadWorktreePath = useThreadSelector((t) => t?.worktreePath);
  const activeThreadWorktreePath = threadOverride?.worktreePath ?? storeActiveThreadWorktreePath;
  const storeActiveThreadProvider = useThreadSelector((t) => t?.provider);
  const activeThreadProvider = threadOverride?.provider ?? storeActiveThreadProvider;
  const storeActiveThreadModel = useThreadSelector((t) => t?.model);
  const activeThreadModel = threadOverride?.model ?? storeActiveThreadModel;
  const storeActiveThreadBranch = useThreadSelector((t) =>
    t ? resolveThreadBranch(t) : undefined,
  );
  const activeThreadBranch = threadOverride?.branch ?? storeActiveThreadBranch;
  const storeActiveThreadBaseBranch = useThreadSelector((t) => t?.baseBranch);
  const activeThreadBaseBranch = threadOverride?.baseBranch ?? storeActiveThreadBaseBranch;
  // Full active thread + its working-tree status, for the prompt powerline bar.
  const activeThread = useThreadSelector((t) => t);
  // SDK-reported slash commands for this thread — merged into the editor's
  // slash autocomplete alongside skills.
  const sdkSlashCommands =
    useThreadSelector((t) => t?.initInfo?.slashCommands) ?? EMPTY_SLASH_COMMANDS;
  const activeThreadGitStatus = useGitStatusForThread(effectiveThreadId);
  const storeActiveThreadContextTokens = useThreadSelector(
    (t) => t?.contextUsage?.cumulativeInputTokens ?? 0,
  );
  const activeThreadContextTokens =
    threadOverride?.contextUsage?.cumulativeInputTokens ?? storeActiveThreadContextTokens;
  const activeThreadLastEffort = useThreadSelector((t) => t?.lastUserMessage?.effort);
  const contextMaxTokens =
    activeThreadProvider && activeThreadModel
      ? getModelContextWindow(activeThreadProvider, activeThreadModel)
      : 200_000;
  // Hide the ring until the agent has actually reported usage. New and forked
  // threads start at 0 and the displayed % would be misleading (a fork inherits
  // real context but no usage event has fired yet for the new threadId).
  // Codex SDK only reports aggregate usage for a whole turn (which can span
  // many model requests), not a snapshot of the active context window. Do not
  // render stale persisted aggregate values as a false context percentage.
  const contextPct =
    activeThreadProvider !== 'codex' && activeThreadContextTokens > 0
      ? Math.min(100, (activeThreadContextTokens / contextMaxTokens) * 100)
      : undefined;

  const applyPersistedMode = useCallback(
    (nextMode: string) => {
      setMode(() => nextMode);
      if (isNewThread || !effectiveThreadId || nextMode === activeThreadPermissionMode) return;

      const mutation = ++modeMutationRef.current;
      void updateThreadPermissionMode(effectiveThreadId, nextMode as PermissionMode).then(
        (saved) => {
          // Preserve a newer picker action. The store rolled back the failed
          // update already; this only repairs the hook-local selected value.
          if (!saved && mutation === modeMutationRef.current) {
            setMode(activeThreadPermissionMode ?? defaultPermissionMode);
            toast.error(t('thread.permissionModeSaveFailed', 'Could not save permission mode'));
          }
        },
      );
    },
    [
      activeThreadPermissionMode,
      defaultPermissionMode,
      effectiveThreadId,
      isNewThread,
      t,
      updateThreadPermissionMode,
    ],
  );

  // Auto mode is Claude-only — fall back to autoEdit when switching providers.
  // Existing threads persist that provider-imposed fallback as well.
  useEffect(() => {
    if (mode === 'auto' && currentProvider !== 'claude') {
      applyPersistedMode('autoEdit');
    }
  }, [applyPersistedMode, currentProvider, mode]);

  // ── Branch state ──
  const selectedBranch = useBranchPickerStore((s) => s.selectedBranch);
  const gitCurrentBranch = useBranchPickerStore((s) => s.currentBranch);
  const fetchBranches = useBranchPickerStore((s) => s.fetchBranches);
  const newThreadBaseBranch = useUIStore((s) => s.newThreadBaseBranch);
  const [sendToBacklog, setSendToBacklog] = useState(false);
  const [followUpBranches, setFollowUpBranches] = useState<string[]>([]);
  const [followUpRemoteBranches, setFollowUpRemoteBranches] = useState<string[]>([]);
  const [followUpDefaultBranch, setFollowUpDefaultBranch] = useState<string | null>(null);
  const [followUpCurrentBranch, setFollowUpCurrentBranch] = useState<string | null>(null);
  const [followUpSelectedBranch, setFollowUpSelectedBranch] = useState<string>('');

  // ── Queue state ──
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessage[]>([]);
  const [queueLoading, setQueueLoading] = useState(false);
  const previewQueuedMessages =
    effectiveThreadId && queuedCount > 0 && queuedNextMessage
      ? [
          {
            id: `preview-queued-message:${effectiveThreadId}`,
            threadId: effectiveThreadId,
            content: queuedNextMessage,
            sortOrder: 0,
            createdAt: '',
          } satisfies QueuedMessage,
        ]
      : [];
  const renderedQueuedMessages =
    queuedMessages.length > 0
      ? queuedMessages
      : cachedQueuedMessages.length > 0
        ? cachedQueuedMessages
        : previewQueuedMessages;

  // ── Dictation ──
  const hasAssemblyaiKey = useProfileStore((s) => s.profile?.hasAssemblyaiKey ?? false);
  const partialTextRef = useRef('');

  const handlePartialTranscript = useCallback((text: string) => {
    partialTextRef.current = text;
    if (text) editorRef.current?.setDictationPreview(text);
  }, []);

  const handleFinalTranscript = useCallback((text: string) => {
    if (text) editorRef.current?.commitDictation(text);
    partialTextRef.current = '';
  }, []);

  const handleDictationError = useCallback(
    (message: string) => {
      toast.error(message || t('prompt.micPermissionDenied', 'Microphone access denied'));
    },
    [t],
  );

  const {
    isRecording,
    isConnecting: isTranscribing,
    start: startRecording,
    toggle: toggleRecording,
    stop: stopRecording,
  } = useDictation({
    onPartial: handlePartialTranscript,
    onFinal: handleFinalTranscript,
    onError: handleDictationError,
  });

  // When recording stops without a final turn, reset the dictation range so
  // the next push-to-talk starts at the current caret instead of replacing
  // the previously-inserted partial.
  const wasRecordingRef = useRef(false);
  useEffect(() => {
    if (wasRecordingRef.current && !isRecording) {
      editorRef.current?.endDictation();
      partialTextRef.current = '';
    }
    wasRecordingRef.current = isRecording;
  }, [isRecording]);

  const editorContainerRef = useRef<HTMLDivElement>(null);

  const stopRecordingRef = useRef(stopRecording);
  useEffect(() => {
    stopRecordingRef.current = stopRecording;
  }, [stopRecording]);

  usePushToTalk({
    enabled: hasAssemblyaiKey,
    containerRef: editorContainerRef,
    isRecording,
    isTranscribing,
    startRecording,
    stopRecording,
  });

  // ── Sync mode with active thread ──
  useEffect(() => {
    if (!isNewThread && activeThreadPermissionMode) {
      setMode(activeThreadPermissionMode);
    } else if (isNewThread) {
      setMode(defaultPermissionMode);
    }
  }, [isNewThread, activeThreadPermissionMode, defaultPermissionMode]);

  useEffect(() => {
    if (!isNewThread && activeThreadProvider && activeThreadModel) {
      setUnifiedModelRaw(`${activeThreadProvider}:${activeThreadModel}`);
    } else if (isNewThread) {
      setUnifiedModelRaw(`${defaultProvider}:${defaultModel}`);
    }
  }, [isNewThread, activeThreadProvider, activeThreadModel, defaultProvider, defaultModel]);

  useEffect(() => {
    if (!isNewThread && activeThreadLastEffort) {
      setEffort(activeThreadLastEffort);
    }
  }, [isNewThread, activeThreadLastEffort]);

  // ── Fetch branches ──
  // Mirror effectiveProject's resolution: an existing thread uses its own
  // project, so projectPath (the editor cwd for @-file completion) points at
  // the right repo even in the live-columns grid. fetchBranches is gated on
  // isNewThread below, where resolvedProjectId collapses to the selected one.
  const effectiveProjectId = resolvedProjectId;
  const projectDefaultBranch = effectiveProjectId
    ? projects.find((p) => p.id === effectiveProjectId)?.defaultBranch
    : undefined;

  useEffect(() => {
    if (isNewThread && effectiveProjectId) {
      fetchBranches(effectiveProjectId, projectDefaultBranch, newThreadBaseBranch);
    }
  }, [isNewThread, effectiveProjectId, projectDefaultBranch, newThreadBaseBranch, fetchBranches]);

  const projectPath = useMemo(
    () =>
      effectiveProjectId ? (projects.find((p) => p.id === effectiveProjectId)?.path ?? '') : '',
    [effectiveProjectId, projects],
  );

  // Fetch follow-up branches — only refetch when the project changes.
  // Branch selection is updated separately when activeThreadBaseBranch changes.
  const storeSelectedProjectId = useProjectStore((s) => s.selectedProjectId);
  const selectedProjectId = threadProjectId ?? storeSelectedProjectId;
  const followUpBranchCacheRef = useRef<{
    projectId: string;
    branches: string[];
    remoteBranches: string[];
    defaultBranch: string | null;
    currentBranch: string | null;
  } | null>(null);

  useEffect(() => {
    if (!isNewThread && selectedProjectId) {
      const cached = followUpBranchCacheRef.current;
      if (cached?.projectId === selectedProjectId) {
        setFollowUpBranches(cached.branches);
        setFollowUpRemoteBranches(cached.remoteBranches);
        setFollowUpDefaultBranch(cached.defaultBranch);
        setFollowUpCurrentBranch(cached.currentBranch);
        return;
      }
      (async () => {
        const result = await api.listBranches(selectedProjectId);
        if (result.isOk()) {
          const data = result.value;
          followUpBranchCacheRef.current = {
            projectId: selectedProjectId,
            branches: data.branches,
            remoteBranches: data.remoteBranches ?? [],
            defaultBranch: data.defaultBranch,
            currentBranch: data.currentBranch,
          };
          setFollowUpBranches(data.branches);
          setFollowUpRemoteBranches(data.remoteBranches ?? []);
          setFollowUpDefaultBranch(data.defaultBranch);
          setFollowUpCurrentBranch(data.currentBranch);
        } else {
          setFollowUpBranches([]);
          setFollowUpCurrentBranch(null);
        }
      })();
    } else {
      setFollowUpBranches([]);
      setFollowUpCurrentBranch(null);
      followUpBranchCacheRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isNewThread, selectedProjectId]);

  // Update selection when the active thread's base branch changes (no network call)
  useEffect(() => {
    if (isNewThread || !selectedProjectId) return;
    const cache = followUpBranchCacheRef.current;
    const branchList = cache?.branches ?? followUpBranches;
    if (activeThreadBaseBranch) {
      setFollowUpSelectedBranch(activeThreadBaseBranch);
    } else {
      const proj = projects.find((p) => p.id === selectedProjectId);
      if (proj?.defaultBranch && branchList.includes(proj.defaultBranch)) {
        setFollowUpSelectedBranch(proj.defaultBranch);
      } else if (cache?.defaultBranch) {
        setFollowUpSelectedBranch(cache.defaultBranch);
      } else if (cache?.currentBranch) {
        setFollowUpSelectedBranch(cache.currentBranch);
      } else if (branchList.length > 0) {
        setFollowUpSelectedBranch(branchList[0]);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isNewThread, selectedProjectId, activeThreadBaseBranch]);

  // ── Skills (provider-scoped, single cache) ──
  // The composer is always mounted, so load eagerly: the `/` menu is ready the
  // instant it's opened, and switching project/provider/model auto-invalidates
  // the cache. `useSlashSkills` is the ONE cache — the editor no longer keeps
  // its own copy. `ensureSlashSkills` feeds both the editor and the submit path
  // (which resolves a leading slash command's thread mode).
  const composerProjectPath = useMemo(
    () =>
      activeThreadWorktreePath ??
      (selectedProjectId ? projects.find((p) => p.id === selectedProjectId)?.path : undefined),
    [activeThreadWorktreePath, selectedProjectId, projects],
  );
  const { slashSkills, slashSkillsLoading, ensureSlashSkills } = useSlashSkills({
    projectPath: composerProjectPath,
    projectId: selectedProjectId ?? undefined,
    provider: currentProvider,
    model: currentModel,
    mode: 'eager',
  });
  const [workflowSuggestions, setWorkflowSuggestions] = useState<WorkflowSummary[]>(
    EMPTY_WORKFLOW_SUGGESTIONS,
  );
  const [workflowSuggestionsLoading, setWorkflowSuggestionsLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!resolvedProjectId) {
      setWorkflowSuggestions(EMPTY_WORKFLOW_SUGGESTIONS);
      setWorkflowSuggestionsLoading(false);
      return;
    }

    setWorkflowSuggestionsLoading(true);
    void api.listWorkflows(resolvedProjectId).then((result) => {
      if (cancelled) return;
      if (result.isOk()) {
        setWorkflowSuggestions(result.value.workflows);
      } else {
        setWorkflowSuggestions(EMPTY_WORKFLOW_SUGGESTIONS);
      }
      setWorkflowSuggestionsLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [resolvedProjectId]);

  // ── Queue fetching ──
  const lastQueueFetchRef = useRef<{
    threadId: string;
    queuedCount: number;
    queuedNextMessage?: string;
  } | null>(null);
  // Stable ref for effectiveThreadId — used by queue handlers and draft persistence
  // to avoid recreating callbacks on every thread switch.
  const threadIdRef = useRef(effectiveThreadId);
  threadIdRef.current = effectiveThreadId;

  useEffect(() => {
    if (!effectiveThreadId) {
      setQueuedMessages((prev) => (prev.length === 0 ? prev : []));
      setQueueLoading(false);
      lastQueueFetchRef.current = null;
      return;
    }

    // Switched to a different thread than the last fetch — clear the previous
    // thread's queue immediately so we never render its messages under the
    // new thread while the fetch is in flight. Without this the local
    // `queuedMessages` state persists across thread switches and contaminates
    // the new thread's input bar.
    const lastFetch = lastQueueFetchRef.current;
    if (lastFetch && lastFetch.threadId !== effectiveThreadId) {
      setQueuedMessages((prev) => (prev.length === 0 ? prev : []));
    }

    // When queuedCount is 0, clear locally without hitting the API.
    if (queuedCount === 0) {
      setQueuedMessages((prev) => (prev.length === 0 ? prev : []));
      setQueueLoading(false);
      lastQueueFetchRef.current = { threadId: effectiveThreadId, queuedCount: 0 };
      return;
    }

    if (queuedNextMessage) {
      setQueuedMessages((prev) =>
        prev.length > 0 && prev[0]?.content !== queuedNextMessage ? [] : prev,
      );
    }

    // Skip if we already fired a fetch for this exact threadId + queue snapshot
    // (prevents StrictMode double-fire from issuing duplicate requests)
    const key = { threadId: effectiveThreadId, queuedCount, queuedNextMessage };
    if (
      lastFetch &&
      lastFetch.threadId === key.threadId &&
      lastFetch.queuedCount === key.queuedCount &&
      lastFetch.queuedNextMessage === key.queuedNextMessage
    ) {
      queueLog.debug('queue effect: skipped (dedup)', {
        threadId: effectiveThreadId,
        queuedCount: String(queuedCount),
      });
      return;
    }
    lastQueueFetchRef.current = key;

    queueLog.info('queue effect: fetching queue', {
      threadId: effectiveThreadId,
      queuedCount: String(queuedCount),
    });

    let cancelled = false;
    setQueueLoading(true);

    void (async () => {
      const result = await api.listQueue(effectiveThreadId);
      if (cancelled) return;
      if (result.isOk()) {
        queueLog.info('queue effect: fetched queue', {
          threadId: effectiveThreadId,
          messageCount: String(result.value.length),
        });
        setQueuedMessages(result.value);
        lastQueueFetchRef.current = {
          threadId: effectiveThreadId,
          queuedCount,
          queuedNextMessage: result.value[0]?.content,
        };
        useThreadStore.setState((state) => {
          const updatedQueueMap =
            result.value.length > 0
              ? { ...state.queuedMessagesByThread, [effectiveThreadId]: result.value }
              : (() => {
                  const { [effectiveThreadId]: _, ...rest } = state.queuedMessagesByThread;
                  return rest;
                })();
          const nextMessage = result.value[0]?.content;
          const updatedNextMap =
            nextMessage && result.value.length > 0
              ? { ...state.queuedNextMessageByThread, [effectiveThreadId]: nextMessage }
              : (() => {
                  const { [effectiveThreadId]: _, ...rest } = state.queuedNextMessageByThread;
                  return rest;
                })();
          return {
            queuedMessagesByThread: updatedQueueMap,
            queuedNextMessageByThread: updatedNextMap,
          };
        });
      } else {
        queueLog.warn('queue effect: fetch failed', {
          threadId: effectiveThreadId,
          error: result.error.message,
        });
        setQueuedMessages((prev) => (prev.length === 0 ? prev : []));
      }
      setQueueLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [effectiveThreadId, queuedCount, queuedNextMessage]);

  // ── Queue handlers ──
  const handleQueueEditSave = useCallback(
    async (messageId: string, content: string) => {
      const tid = threadIdRef.current;
      if (!tid) return;
      const result = await api.updateQueuedMessage(tid, messageId, content);
      if (result.isOk()) {
        setQueuedMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, content } : m)));
        useThreadStore.setState((state) => {
          const current = state.queuedMessagesByThread[tid] ?? [];
          const next = current.map((m) => (m.id === messageId ? { ...m, content } : m));
          return {
            queuedMessagesByThread: { ...state.queuedMessagesByThread, [tid]: next },
            queuedNextMessageByThread: next[0]?.content
              ? { ...state.queuedNextMessageByThread, [tid]: next[0].content }
              : state.queuedNextMessageByThread,
          };
        });
      } else {
        toastError(result.error);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const handleQueueDelete = useCallback(
    async (messageId: string) => {
      const tid = threadIdRef.current;
      if (!tid) return;
      const result = await api.cancelQueuedMessage(tid, messageId);
      if (result.isOk()) {
        setQueuedMessages((prev) => prev.filter((m) => m.id !== messageId));

        // Sync the store's queuedCount with the server's authoritative value.
        // Single write path: patch the unified payload map (mirrors onto
        // activeThread when this is the selected thread) plus the persistent
        // by-thread map that survives thread switches.
        const newCount = result.value.queuedCount;
        useThreadStore.setState((state) => {
          const updatedMap =
            newCount > 0
              ? { ...state.queuedCountByThread, [tid]: newCount }
              : (() => {
                  const { [tid]: _, ...rest } = state.queuedCountByThread;
                  return rest;
                })();
          const filtered = (state.queuedMessagesByThread[tid] ?? []).filter(
            (m) => m.id !== messageId,
          );
          const nextContent = filtered[0]?.content;
          return {
            queuedCountByThread: updatedMap,
            queuedMessagesByThread:
              newCount > 0
                ? {
                    ...state.queuedMessagesByThread,
                    [tid]: filtered,
                  }
                : (() => {
                    const { [tid]: _, ...rest } = state.queuedMessagesByThread;
                    return rest;
                  })(),
            queuedNextMessageByThread:
              newCount > 0 && nextContent
                ? { ...state.queuedNextMessageByThread, [tid]: nextContent }
                : (() => {
                    const { [tid]: _, ...rest } = state.queuedNextMessageByThread;
                    return rest;
                  })(),
            ...mutations.applyThreadDataPatch(state, tid, (t) => ({
              ...t,
              queuedCount: newCount,
            })),
          };
        });
      } else {
        toastError(result.error);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // ── Draft persistence ──
  const { setEditorDraft, clearPromptDraft } = useDraftStore();
  const prevThreadIdRef = useRef<string | null | undefined>(null);
  const hasSubmittedRef = useRef(false);
  const imagesRef = useRef<ImageAttachment[]>([]);

  useEffect(() => {
    const prevId = prevThreadIdRef.current;
    prevThreadIdRef.current = effectiveThreadId;

    if (prevId && prevId !== effectiveThreadId) {
      const editorJSON = editorRef.current?.getJSON();
      if (editorJSON) {
        setEditorDraft(prevId, editorJSON, imagesRef.current);
      }
    }

    if (effectiveThreadId && effectiveThreadId !== prevId) {
      const draft = useDraftStore.getState().drafts[effectiveThreadId];
      if (draft?.editorContent) {
        editorRef.current?.setContent(draft.editorContent);
      } else if (draft?.prompt) {
        editorRef.current?.setContent(draft.prompt);
      } else if (initialPromptProp) {
        editorRef.current?.setContent(initialPromptProp);
      } else {
        editorRef.current?.clear();
      }
    } else if (!effectiveThreadId && prevId) {
      editorRef.current?.clear();
    }
    stopRecordingRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveThreadId]);

  useEffect(() => {
    const editorRefCurrent = editorRef.current;
    const currentImages = imagesRef.current;
    return () => {
      if (hasSubmittedRef.current) return;
      const threadId = threadIdRef.current;
      if (threadId) {
        const editorJSON = editorRefCurrent?.getJSON();
        if (editorJSON) {
          setEditorDraft(threadId, editorJSON, currentImages);
        }
      }
    };
  }, [setEditorDraft]);

  // Focus editor on thread switch / state changes
  useEffect(() => {
    editorRef.current?.focus();
  }, [effectiveThreadId]);
  useEffect(() => {
    if (!running) editorRef.current?.focus();
  }, [running]);
  useEffect(() => {
    if (!loading) editorRef.current?.focus();
  }, [loading]);

  useEffect(() => {
    if (initialPromptProp) editorRef.current?.setContent(initialPromptProp);
  }, [initialPromptProp]);

  // ── Branch switch (shared hook) ──
  const { ensureBranch, branchSwitchDialog } = useBranchSwitch();

  const handleCheckoutPreflight = useCallback(
    async (branch: string): Promise<boolean> => {
      if (!effectiveProjectId || !gitCurrentBranch || branch === gitCurrentBranch) return true;
      return ensureBranch(effectiveProjectId, branch);
    },
    [effectiveProjectId, gitCurrentBranch, ensureBranch],
  );

  // Checkout on follow-up branch change so ReviewPane refreshes immediately.
  // Wait for ensureBranch to confirm before updating the picker — otherwise
  // cancelling the dirty-files dialog leaves the UI on a branch we never switched to.
  const handleFollowUpBranchChange = useCallback(
    async (branch: string) => {
      if (effectiveProjectId && branch !== gitCurrentBranch) {
        const ok = await ensureBranch(effectiveProjectId, branch);
        if (!ok) return;
      }
      setFollowUpSelectedBranch(branch);
    },
    [effectiveProjectId, gitCurrentBranch, ensureBranch],
  );

  // ── Editor change handler (for content tracking) ──
  const handleEditorChange = useCallback(() => {
    if (onContentChange) {
      const hasContent = !(editorRef.current?.isEmpty() ?? true);
      const text = editorRef.current?.getText() ?? '';
      onContentChange(hasContent, text);
    }
  }, [onContentChange]);

  // Image pasting is handled by PromptInputUI internally
  const handleEditorPaste = useCallback(async (_e: ClipboardEvent) => {
    // no-op — PromptInputUI owns paste handling
  }, []);

  // ── Effective cwd ──
  const threadCwd = activeThreadWorktreePath || projectPath;

  // ── Wrapped onSubmit to track submission for draft ──
  const onSubmitRef = useRef(onSubmit);
  onSubmitRef.current = onSubmit;
  const clearPromptDraftRef = useRef(clearPromptDraft);
  clearPromptDraftRef.current = clearPromptDraft;

  const handleCompact = useCallback(async () => {
    const tid = threadIdRef.current;
    if (!tid) return;
    const result = await api.sendMessage(tid, '/compact');
    if (result.isErr()) {
      toastError(result.error);
    } else {
      toast.success(t('prompt.compactRequested', 'Compaction requested'));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t]);

  const wrappedOnSubmit = useCallback(
    async (prompt: string, opts: SubmitOpts, images?: ImageAttachment[]) => {
      hasSubmittedRef.current = true;
      const tid = threadIdRef.current;
      if (tid) clearPromptDraftRef.current(tid);
      const result = await onSubmitRef.current(prompt, opts, images);
      if (result === false) {
        hasSubmittedRef.current = false;
      }
      return result;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  return {
    // Editor refs
    editorRef,
    editorContainerRef,

    // Submission
    wrappedOnSubmit,

    // Queue
    queuedCount,
    queuedMessages: renderedQueuedMessages,
    queueLoading,
    handleQueueEditSave,
    handleQueueDelete,

    // Model & mode
    unifiedModel,
    setUnifiedModel,
    unifiedModelGroups,
    mode,
    setMode: applyPersistedMode,
    modes,
    createWorktree,
    setCreateWorktree,
    runtime,
    setRuntime,
    hasLauncher,
    effort,
    setEffort,
    effortOptions,

    // Branch
    selectedBranch,
    followUpBranches,
    followUpRemoteBranches,
    followUpDefaultBranch,
    followUpCurrentBranch,
    followUpSelectedBranch,
    handleFollowUpBranchChange,
    activeThreadBranch,

    // Backlog
    sendToBacklog,
    setSendToBacklog,

    // Dictation
    hasAssemblyaiKey,
    isRecording,
    isTranscribing,
    toggleRecording,
    stopRecording,

    // Editor handlers
    handleEditorChange,
    handleEditorPaste,
    handleCheckoutPreflight,
    // `ensureSlashSkills` resolves the (eagerly-loaded) list for the submit
    // path; `slashSkills`/`slashSkillsLoading` feed the editor's `/` menu.
    ensureSlashSkills,
    slashSkills,
    slashSkillsLoading,
    sdkSlashCommands,
    workflowSuggestions,
    workflowSuggestionsLoading,
    // Provider that owns the slash menu: the active thread's provider when
    // viewing one, else the composer's selected provider. Gates Claude-specific
    // built-in command labels so a Codex/GPT thread isn't shown Claude wording.
    slashCommandProvider: activeThreadProvider ?? currentProvider,

    // Misc
    threadCwd,
    activeThread,
    activeThreadGitStatus,
    effectiveProject,
    effectiveThreadId,
    contextPct,
    activeThreadContextTokens,
    contextMaxTokens,
    handleCompact,

    // Branch-switch dialog (rendered by parent)
    branchSwitchDialog: branchSwitchDialog as ReactElement | null,
  };
}
