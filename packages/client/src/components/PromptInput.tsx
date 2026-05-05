import type { ImageAttachment, QueuedMessage, Skill } from '@funny/shared';
import {
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  DEFAULT_PERMISSION_MODE,
  DEFAULT_THREAD_MODE,
  getModelContextWindow,
} from '@funny/shared/models';
import { useState, useRef, useEffect, useCallback, useMemo, memo } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { useBranchSwitch } from '@/hooks/use-branch-switch';
import { useDictation } from '@/hooks/use-dictation';
import { usePiPromptModels } from '@/hooks/use-pi-prompt-models';
import { api } from '@/lib/api';
import { getEffortLevels, getUnifiedModelOptions, parseUnifiedModel } from '@/lib/providers';
import { toastError } from '@/lib/toast-error';
import { resolveThreadBranch } from '@/lib/utils';
import { useBranchPickerStore } from '@/stores/branch-picker-store';
import { useDraftStore } from '@/stores/draft-store';
import { useProfileStore } from '@/stores/profile-store';
import { useProjectStore } from '@/stores/project-store';
import { useThreadStore } from '@/stores/thread-store';

import type { PromptEditorHandle } from './prompt-editor/PromptEditor';
import { PromptInputUI } from './PromptInputUI';

const piLog = createClientLogger('PromptInput');

// ── Props (unchanged external API) ──────────────────────────────

interface PromptInputProps {
  onSubmit: (
    prompt: string,
    opts: {
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
    },
    images?: ImageAttachment[],
  ) => Promise<boolean | void> | boolean | void;
  onStop?: () => void;
  loading?: boolean;
  running?: boolean;
  queuedCount?: number;
  queuedNextMessage?: string;
  isQueueMode?: boolean;
  placeholder?: string;
  isNewThread?: boolean;
  showBacklog?: boolean;
  projectId?: string;
  threadId?: string | null;
  initialPrompt?: string;
  initialImages?: ImageAttachment[];
  /** Imperative ref — PromptInput writes setPrompt into it so the parent can restore text */
  setPromptRef?: React.RefObject<((text: string) => void) | null>;
  /** Called when the editor content changes — reports whether it has content and the current text */
  onContentChange?: (hasContent: boolean, text: string) => void;
  /** Called when the worktree mode toggle changes */
  onWorktreeModeChange?: (enabled: boolean) => void;
}

// ── Connected wrapper ───────────────────────────────────────────

export const PromptInput = memo(function PromptInput({
  onSubmit,
  onStop,
  loading = false,
  running = false,
  queuedCount: queuedCountProp = 0,
  isQueueMode = false,
  placeholder,
  isNewThread = false,
  showBacklog = false,
  projectId: propProjectId,
  threadId: threadIdProp,
  initialPrompt: initialPromptProp,
  initialImages: initialImagesProp,
  setPromptRef,
  onContentChange,
  onWorktreeModeChange,
}: PromptInputProps) {
  const { t } = useTranslation();

  // Read queuedCount directly from the store to avoid stale prop values.
  // The prop may lag behind when ThreadView re-renders are deferred by memo().
  const storeQueuedCount = useThreadStore((s) => s.activeThread?.queuedCount ?? 0);
  const queuedCount = storeQueuedCount > 0 ? storeQueuedCount : queuedCountProp;

  // ── Project defaults ──
  const projects = useProjectStore((s) => s.projects);
  const selectedProjectIdForDefaults = useProjectStore((s) => s.selectedProjectId);
  const effectiveProject =
    propProjectId || selectedProjectIdForDefaults
      ? projects.find((p) => p.id === (propProjectId || selectedProjectIdForDefaults))
      : undefined;
  const defaultProvider = effectiveProject?.defaultProvider ?? DEFAULT_PROVIDER;
  const defaultModel = effectiveProject?.defaultModel ?? DEFAULT_MODEL;
  const defaultPermissionMode = effectiveProject?.defaultPermissionMode ?? DEFAULT_PERMISSION_MODE;
  const defaultThreadMode = effectiveProject?.defaultMode ?? DEFAULT_THREAD_MODE;

  // ── Editor ref ──
  const editorRef = useRef<PromptEditorHandle>(null);

  // ── Model & mode state ──
  const [unifiedModel, setUnifiedModel] = useState<string>(`${defaultProvider}:${defaultModel}`);
  const [mode, setMode] = useState<string>(defaultPermissionMode);
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

  const baseUnifiedModelGroups = useMemo(() => getUnifiedModelOptions(t), [t]);
  const unifiedModelGroups = usePiPromptModels(baseUnifiedModelGroups);

  // Effort options — available for providers that support reasoning levels (Claude, Codex)
  const { provider: currentProvider, model: currentModel } = useMemo(
    () => parseUnifiedModel(unifiedModel),
    [unifiedModel],
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
    // Auto mode is only available for Claude provider (uses safety classifier)
    if (currentProvider === 'claude') {
      baseModes.splice(2, 0, { value: 'auto', label: t('prompt.auto') });
    }
    return baseModes;
  }, [t, currentProvider]);

  // Auto mode is Claude-only — fall back to autoEdit when switching providers
  useEffect(() => {
    if (mode === 'auto' && currentProvider !== 'claude') {
      setMode('autoEdit');
    }
  }, [currentProvider, mode]);

  // ── Active thread state ──
  const activeThreadPermissionMode = useThreadStore((s) => s.activeThread?.permissionMode);
  const activeThreadWorktreePath = useThreadStore((s) => s.activeThread?.worktreePath);
  const activeThreadProvider = useThreadStore((s) => s.activeThread?.provider);
  const activeThreadModel = useThreadStore((s) => s.activeThread?.model);
  const activeThreadBranch = useThreadStore((s) =>
    s.activeThread ? resolveThreadBranch(s.activeThread) : undefined,
  );
  const activeThreadBaseBranch = useThreadStore((s) => s.activeThread?.baseBranch);
  const activeThreadContextTokens = useThreadStore(
    (s) => s.activeThread?.contextUsage?.cumulativeInputTokens ?? 0,
  );
  const contextMaxTokens =
    activeThreadProvider && activeThreadModel
      ? getModelContextWindow(activeThreadProvider, activeThreadModel)
      : 200_000;
  const contextPct = Math.min(100, (activeThreadContextTokens / contextMaxTokens) * 100);

  // ── Branch state (new-thread: from shared store, follow-up: local) ──
  const selectedBranch = useBranchPickerStore((s) => s.selectedBranch);
  const gitCurrentBranch = useBranchPickerStore((s) => s.currentBranch);
  const fetchBranches = useBranchPickerStore((s) => s.fetchBranches);
  const [sendToBacklog, setSendToBacklog] = useState(false);
  const [followUpBranches, setFollowUpBranches] = useState<string[]>([]);
  const [followUpRemoteBranches, setFollowUpRemoteBranches] = useState<string[]>([]);
  const [followUpDefaultBranch, setFollowUpDefaultBranch] = useState<string | null>(null);
  const [followUpCurrentBranch, setFollowUpCurrentBranch] = useState<string | null>(null);
  const [followUpSelectedBranch, setFollowUpSelectedBranch] = useState<string>('');

  // ── Queue state ──
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessage[]>([]);
  const [queueLoading, setQueueLoading] = useState(false);

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

  // When recording stops (mic released) without a final turn, reset the
  // dictation range so the next push-to-talk starts at the current caret
  // instead of replacing the previously-inserted partial.
  const wasRecordingRef = useRef(false);
  useEffect(() => {
    if (wasRecordingRef.current && !isRecording) {
      editorRef.current?.endDictation();
      partialTextRef.current = '';
    }
    wasRecordingRef.current = isRecording;
  }, [isRecording]);

  // Push-to-talk refs
  const pttActiveRef = useRef(false);
  const isRecordingRef = useRef(isRecording);
  const isTranscribingRef = useRef(isTranscribing);
  const startRecordingRef = useRef(startRecording);
  const stopRecordingRef = useRef(stopRecording);
  const editorContainerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    isRecordingRef.current = isRecording;
  }, [isRecording]);
  useEffect(() => {
    isTranscribingRef.current = isTranscribing;
  }, [isTranscribing]);
  useEffect(() => {
    startRecordingRef.current = startRecording;
  }, [startRecording]);
  useEffect(() => {
    stopRecordingRef.current = stopRecording;
  }, [stopRecording]);

  const pttStopTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (!hasAssemblyaiKey) return;

    const keysDown = { ctrl: false, alt: false };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Control') keysDown.ctrl = true;
      if (e.key === 'Alt') keysDown.alt = true;

      const active = document.activeElement;
      const inPrompt = active && editorContainerRef.current?.contains(active);
      if (
        keysDown.ctrl &&
        keysDown.alt &&
        inPrompt &&
        !pttActiveRef.current &&
        !isRecordingRef.current &&
        !isTranscribingRef.current
      ) {
        e.preventDefault();
        if (pttStopTimerRef.current) {
          clearTimeout(pttStopTimerRef.current);
          pttStopTimerRef.current = undefined;
        }
        pttActiveRef.current = true;
        startRecordingRef.current();
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Control') keysDown.ctrl = false;
      if (e.key === 'Alt') keysDown.alt = false;

      if (pttActiveRef.current && (!keysDown.ctrl || !keysDown.alt)) {
        pttActiveRef.current = false;
        pttStopTimerRef.current = setTimeout(() => {
          pttStopTimerRef.current = undefined;
          stopRecordingRef.current();
        }, 500);
      }
    };

    const handleBlur = () => {
      keysDown.ctrl = false;
      keysDown.alt = false;
      if (pttActiveRef.current) pttActiveRef.current = false;
      if (pttStopTimerRef.current) {
        clearTimeout(pttStopTimerRef.current);
        pttStopTimerRef.current = undefined;
      }
      stopRecordingRef.current();
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleBlur);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleBlur);
      if (pttStopTimerRef.current) clearTimeout(pttStopTimerRef.current);
    };
  }, [hasAssemblyaiKey]);

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
      setUnifiedModel(`${activeThreadProvider}:${activeThreadModel}`);
    } else if (isNewThread) {
      setUnifiedModel(`${defaultProvider}:${defaultModel}`);
    }
  }, [isNewThread, activeThreadProvider, activeThreadModel, defaultProvider, defaultModel]);

  // ── Fetch branches ──
  const effectiveProjectId = propProjectId || useProjectStore.getState().selectedProjectId;
  const projectDefaultBranch = effectiveProjectId
    ? projects.find((p) => p.id === effectiveProjectId)?.defaultBranch
    : undefined;

  useEffect(() => {
    if (isNewThread && effectiveProjectId) {
      fetchBranches(effectiveProjectId, projectDefaultBranch);
    }
  }, [isNewThread, effectiveProjectId, projectDefaultBranch, fetchBranches]);

  // Fetch remote URL
  const projectPath = useMemo(
    () =>
      effectiveProjectId ? (projects.find((p) => p.id === effectiveProjectId)?.path ?? '') : '',
    [effectiveProjectId, projects],
  );

  // Fetch follow-up branches — only refetch when the project changes.
  // Branch selection is updated separately when activeThreadBaseBranch changes.
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId);
  const followUpBranchCacheRef = useRef<{
    projectId: string;
    branches: string[];
    remoteBranches: string[];
    defaultBranch: string | null;
    currentBranch: string | null;
  } | null>(null);

  useEffect(() => {
    if (!isNewThread && selectedProjectId) {
      // Use cached data if we already fetched for this project
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

  // ── Skills ──
  const skillsCacheRef = useRef<Skill[] | null>(null);
  useEffect(() => {
    skillsCacheRef.current = null;
  }, [selectedProjectId]);

  const loadSkillsForEditor = useCallback(async (): Promise<Skill[]> => {
    if (skillsCacheRef.current) return skillsCacheRef.current;
    const path = selectedProjectId
      ? projects.find((p) => p.id === selectedProjectId)?.path
      : undefined;
    const result = await api.listSkills(path);
    if (result.isOk()) {
      const allSkills = result.value.skills ?? [];
      const deduped = new Map<string, Skill>();
      for (const skill of allSkills) {
        const existing = deduped.get(skill.name);
        if (!existing || skill.scope === 'project') {
          deduped.set(skill.name, skill);
        }
      }
      skillsCacheRef.current = Array.from(deduped.values());
    } else {
      skillsCacheRef.current = [];
    }
    return skillsCacheRef.current;
  }, [selectedProjectId, projects]);

  // ── Queue fetching ──
  const selectedThreadId = useThreadStore((s) => s.selectedThreadId);
  const effectiveThreadId = threadIdProp ?? selectedThreadId;
  const lastQueueFetchRef = useRef<{ threadId: string; queuedCount: number } | null>(null);
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

    // When queuedCount is 0, clear locally without hitting the API.
    // This avoids ~900ms API calls on every thread switch when both threads
    // have an empty queue.
    if (queuedCount === 0) {
      setQueuedMessages((prev) => (prev.length === 0 ? prev : []));
      setQueueLoading(false);
      lastQueueFetchRef.current = { threadId: effectiveThreadId, queuedCount: 0 };
      return;
    }

    // Skip if we already fired a fetch for this exact threadId + queuedCount
    // (prevents StrictMode double-fire from issuing duplicate requests)
    const key = { threadId: effectiveThreadId, queuedCount };
    if (
      lastQueueFetchRef.current &&
      lastQueueFetchRef.current.threadId === key.threadId &&
      lastQueueFetchRef.current.queuedCount === key.queuedCount
    ) {
      piLog.debug('queue effect: skipped (dedup)', {
        threadId: effectiveThreadId,
        queuedCount: String(queuedCount),
      });
      return;
    }
    lastQueueFetchRef.current = key;

    piLog.info('queue effect: fetching queue', {
      threadId: effectiveThreadId,
      queuedCount: String(queuedCount),
    });

    let cancelled = false;
    setQueueLoading(true);

    void (async () => {
      const result = await api.listQueue(effectiveThreadId);
      if (cancelled) return;
      if (result.isOk()) {
        piLog.info('queue effect: fetched queue', {
          threadId: effectiveThreadId,
          messageCount: String(result.value.length),
        });
        setQueuedMessages(result.value);
      } else {
        piLog.warn('queue effect: fetch failed', {
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
  }, [effectiveThreadId, queuedCount]);

  // ── Queue handlers ──
  // Use threadIdRef to keep callback identities stable across thread switches,
  // preventing PromptInputUI re-renders.
  const handleQueueEditSave = useCallback(
    async (messageId: string, content: string) => {
      const tid = threadIdRef.current;
      if (!tid) return;
      const result = await api.updateQueuedMessage(tid, messageId, content);
      if (result.isOk()) {
        setQueuedMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, content } : m)));
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

        // Sync the store's queuedCount with the server's authoritative value
        const newCount = result.value.queuedCount;
        const state = useThreadStore.getState();
        const { queuedCountByThread, activeThread } = state;
        const updatedMap =
          newCount > 0
            ? { ...queuedCountByThread, [tid]: newCount }
            : (() => {
                const { [tid]: _, ...rest } = queuedCountByThread;
                return rest;
              })();

        if (activeThread?.id === tid) {
          useThreadStore.setState({
            activeThread: { ...activeThread, queuedCount: newCount },
            queuedCountByThread: updatedMap,
          });
        } else {
          useThreadStore.setState({ queuedCountByThread: updatedMap });
        }
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

  // Load initial prompt/images from props
  useEffect(() => {
    if (initialPromptProp) editorRef.current?.setContent(initialPromptProp);
    if (initialImagesProp?.length) {
      // Images are managed by PromptInputUI, but we need to pass them as initial
    }
  }, [initialPromptProp, initialImagesProp]);

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

  // ── Editor paste handler (for draft tracking) ──
  const handleEditorPaste = useCallback(async (e: ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    // Image pasting is handled by PromptInputUI internally
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
    async (prompt: string, opts: Parameters<typeof onSubmit>[1], images?: ImageAttachment[]) => {
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

  return (
    <>
      <PromptInputUI
        onSubmit={wrappedOnSubmit}
        onStop={onStop}
        loading={loading}
        running={running}
        queuedCount={queuedCount}
        isQueueMode={isQueueMode}
        queuedMessages={queuedMessages}
        queueLoading={queueLoading}
        onQueueEditSave={handleQueueEditSave}
        onQueueDelete={handleQueueDelete}
        unifiedModel={unifiedModel}
        onUnifiedModelChange={setUnifiedModel}
        modelGroups={unifiedModelGroups}
        mode={mode}
        onModeChange={setMode}
        modes={modes}
        isNewThread={isNewThread}
        createWorktree={createWorktree}
        onCreateWorktreeChange={setCreateWorktree}
        runtime={runtime}
        onRuntimeChange={setRuntime}
        hasLauncher={hasLauncher}
        selectedBranch={selectedBranch}
        followUpBranches={followUpBranches}
        followUpRemoteBranches={followUpRemoteBranches}
        followUpDefaultBranch={followUpDefaultBranch}
        followUpSelectedBranch={followUpSelectedBranch}
        onFollowUpSelectedBranchChange={handleFollowUpBranchChange}
        activeThreadBranch={activeThreadBranch ?? followUpCurrentBranch ?? undefined}
        effectiveCwd={threadCwd}
        showBacklog={showBacklog}
        sendToBacklog={sendToBacklog}
        onSendToBacklogChange={setSendToBacklog}
        hasDictation={hasAssemblyaiKey}
        isRecording={isRecording}
        isTranscribing={isTranscribing}
        onToggleRecording={toggleRecording}
        onStopRecording={stopRecording}
        placeholder={placeholder}
        editorCwd={threadCwd}
        loadSkills={loadSkillsForEditor}
        setPromptRef={setPromptRef}
        editorRef={editorRef}
        editorContainerRef={editorContainerRef}
        initialPrompt={initialPromptProp}
        initialImages={initialImagesProp}
        onEditorChange={handleEditorChange}
        onEditorPaste={handleEditorPaste}
        onCheckoutPreflight={handleCheckoutPreflight}
        effort={effortOptions.length > 0 ? effort : undefined}
        onEffortChange={effortOptions.length > 0 ? setEffort : undefined}
        effortOptions={effortOptions.length > 0 ? effortOptions : undefined}
        defaultTemplateId={effectiveProject?.defaultAgentTemplateId}
        contextPct={contextPct}
        contextUsedTokens={activeThreadContextTokens}
        contextMaxTokens={contextMaxTokens}
        onCompact={effectiveThreadId ? handleCompact : undefined}
      />

      {branchSwitchDialog}
    </>
  );
});
