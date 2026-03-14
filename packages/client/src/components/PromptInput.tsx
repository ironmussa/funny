import type { ImageAttachment, QueuedMessage, Skill } from '@funny/shared';
import {
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  DEFAULT_PERMISSION_MODE,
  DEFAULT_THREAD_MODE,
} from '@funny/shared/models';
import { useState, useRef, useEffect, useCallback, useMemo, memo } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { useDictation } from '@/hooks/use-dictation';
import { api } from '@/lib/api';
import { getUnifiedModelOptions } from '@/lib/providers';
import { useDraftStore } from '@/stores/draft-store';
import { useProjectStore } from '@/stores/project-store';
import { useThreadStore } from '@/stores/thread-store';

import type { PromptEditorHandle } from './prompt-editor/PromptEditor';
import { PromptInputUI } from './PromptInputUI';

// ── Props (unchanged external API) ──────────────────────────────

interface PromptInputProps {
  onSubmit: (
    prompt: string,
    opts: {
      provider?: string;
      model: string;
      mode: string;
      threadMode?: string;
      runtime?: string;
      baseBranch?: string;
      cwd?: string;
      sendToBacklog?: boolean;
      fileReferences?: { path: string; type?: 'file' | 'folder' }[];
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
}

// ── Connected wrapper ───────────────────────────────────────────

export const PromptInput = memo(function PromptInput({
  onSubmit,
  onStop,
  loading = false,
  running = false,
  queuedCount = 0,
  isQueueMode = false,
  placeholder,
  isNewThread = false,
  showBacklog = false,
  projectId: propProjectId,
  threadId: threadIdProp,
  initialPrompt: initialPromptProp,
  initialImages: initialImagesProp,
  setPromptRef,
}: PromptInputProps) {
  const { t } = useTranslation();

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
  const [createWorktree, setCreateWorktree] = useState(defaultThreadMode === 'worktree');
  const [runtime, setRuntime] = useState<'local' | 'remote'>('local');
  const hasLauncher = !!effectiveProject?.launcherUrl;

  const unifiedModelGroups = useMemo(() => getUnifiedModelOptions(t), [t]);
  const modes = useMemo(
    () => [
      { value: 'ask', label: t('prompt.ask') },
      { value: 'plan', label: t('prompt.plan') },
      { value: 'autoEdit', label: t('prompt.autoEdit') },
      { value: 'confirmEdit', label: t('prompt.askBeforeEdits') },
    ],
    [t],
  );

  // ── Active thread state ──
  const activeThreadPermissionMode = useThreadStore((s) => s.activeThread?.permissionMode);
  const activeThreadWorktreePath = useThreadStore((s) => s.activeThread?.worktreePath);
  const activeThreadProvider = useThreadStore((s) => s.activeThread?.provider);
  const activeThreadModel = useThreadStore((s) => s.activeThread?.model);
  const activeThreadBranch = useThreadStore((s) => s.activeThread?.branch);
  const activeThreadBaseBranch = useThreadStore((s) => s.activeThread?.baseBranch);

  // ── Branch state ──
  const [newThreadBranches, setNewThreadBranches] = useState<string[]>([]);
  const [newThreadBranchesLoading, setNewThreadBranchesLoading] = useState(false);
  const [selectedBranch, setSelectedBranch] = useState<string>('');
  const [sendToBacklog, setSendToBacklog] = useState(false);
  const [followUpBranches, setFollowUpBranches] = useState<string[]>([]);
  const [followUpSelectedBranch, setFollowUpSelectedBranch] = useState<string>('');
  const [gitCurrentBranch, setGitCurrentBranch] = useState<string | null>(null);
  const [remoteUrl, setRemoteUrl] = useState<string | null>(null);

  // ── Queue state ──
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessage[]>([]);
  const [queueLoading, setQueueLoading] = useState(false);

  // ── Dictation ──
  const [hasAssemblyaiKey, setHasAssemblyaiKey] = useState(false);
  const partialTextRef = useRef('');

  useEffect(() => {
    api.getProfile().then((result) => {
      if (result.isOk() && result.value) {
        setHasAssemblyaiKey(result.value.hasAssemblyaiKey);
      }
    });
  }, []);

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
      setNewThreadBranchesLoading(true);
      (async () => {
        const result = await api.listBranches(effectiveProjectId);
        if (result.isOk()) {
          const data = result.value;
          setNewThreadBranches(data.branches);
          setGitCurrentBranch(data.currentBranch);
          if (!createWorktree && data.currentBranch && data.branches.includes(data.currentBranch)) {
            setSelectedBranch(data.currentBranch);
          } else if (projectDefaultBranch && data.branches.includes(projectDefaultBranch)) {
            setSelectedBranch(projectDefaultBranch);
          } else if (data.defaultBranch) {
            setSelectedBranch(data.defaultBranch);
          } else if (data.branches.length > 0) {
            setSelectedBranch(data.branches[0]);
          }
        } else {
          setNewThreadBranches([]);
          setGitCurrentBranch(null);
        }
        setNewThreadBranchesLoading(false);
      })();
    }
  }, [isNewThread, effectiveProjectId, projectDefaultBranch, createWorktree]);

  // Fetch remote URL
  const projectPath = useMemo(
    () =>
      effectiveProjectId ? (projects.find((p) => p.id === effectiveProjectId)?.path ?? '') : '',
    [effectiveProjectId, projects],
  );

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

  // Fetch follow-up branches
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId);
  useEffect(() => {
    if (!isNewThread && selectedProjectId) {
      (async () => {
        const result = await api.listBranches(selectedProjectId);
        if (result.isOk()) {
          const data = result.value;
          setFollowUpBranches(data.branches);
          const proj = projects.find((p) => p.id === selectedProjectId);
          if (activeThreadBaseBranch) {
            setFollowUpSelectedBranch(activeThreadBaseBranch);
          } else if (proj?.defaultBranch && data.branches.includes(proj.defaultBranch)) {
            setFollowUpSelectedBranch(proj.defaultBranch);
          } else if (data.defaultBranch) {
            setFollowUpSelectedBranch(data.defaultBranch);
          } else if (data.currentBranch) {
            setFollowUpSelectedBranch(data.currentBranch);
          } else if (data.branches.length > 0) {
            setFollowUpSelectedBranch(data.branches[0]);
          }
        } else {
          setFollowUpBranches([]);
        }
      })();
    } else {
      setFollowUpBranches([]);
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

  useEffect(() => {
    if (!effectiveThreadId) {
      setQueuedMessages([]);
      setQueueLoading(false);
      lastQueueFetchRef.current = null;
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
      return;
    }
    lastQueueFetchRef.current = key;

    let cancelled = false;
    setQueueLoading(true);

    void (async () => {
      const result = await api.listQueue(effectiveThreadId);
      if (cancelled) return;
      if (result.isOk()) {
        setQueuedMessages(result.value);
      } else {
        setQueuedMessages([]);
      }
      setQueueLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [effectiveThreadId, queuedCount]);

  // ── Queue handlers ──
  const handleQueueEditSave = useCallback(
    async (messageId: string, content: string) => {
      if (!effectiveThreadId) return;
      const result = await api.updateQueuedMessage(effectiveThreadId, messageId, content);
      if (result.isOk()) {
        setQueuedMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, content } : m)));
      } else {
        toast.error(result.error.message);
      }
    },
    [effectiveThreadId],
  );

  const handleQueueDelete = useCallback(
    async (messageId: string) => {
      if (!effectiveThreadId) return;
      const result = await api.cancelQueuedMessage(effectiveThreadId, messageId);
      if (result.isOk()) {
        setQueuedMessages((prev) => prev.filter((m) => m.id !== messageId));
      } else {
        toast.error(result.error.message);
      }
    },
    [effectiveThreadId],
  );

  // ── Draft persistence ──
  const { setEditorDraft, clearPromptDraft } = useDraftStore();
  const prevThreadIdRef = useRef<string | null | undefined>(null);
  const hasSubmittedRef = useRef(false);
  const imagesRef = useRef<ImageAttachment[]>([]);
  const threadIdRef = useRef(effectiveThreadId);
  threadIdRef.current = effectiveThreadId;

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
    } else if (!effectiveThreadId) {
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

  // ── Checkout preflight ──
  const handleCheckoutPreflight = useCallback(
    async (branch: string): Promise<boolean> => {
      if (!effectiveProjectId || !gitCurrentBranch || branch === gitCurrentBranch) return true;
      const preflight = await api.checkoutPreflight(effectiveProjectId, branch);
      if (preflight.isOk() && !preflight.value.canCheckout) {
        const files = preflight.value.conflictingFiles?.join(', ') || '';
        toast.error(
          t('prompt.checkoutBlocked', {
            branch,
            currentBranch: gitCurrentBranch,
            files,
          }),
          { duration: 8000 },
        );
        return false;
      }
      return true;
    },
    [effectiveProjectId, gitCurrentBranch, t],
  );

  // ── Editor paste handler (for draft tracking) ──
  const handleEditorPaste = useCallback(async (e: ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    // Image pasting is handled by PromptInputUI internally
  }, []);

  // ── Effective cwd ──
  const threadCwd = activeThreadWorktreePath || projectPath;

  // ── Wrapped onSubmit to track submission for draft ──
  const wrappedOnSubmit = useCallback(
    async (prompt: string, opts: Parameters<typeof onSubmit>[1], images?: ImageAttachment[]) => {
      hasSubmittedRef.current = true;
      if (effectiveThreadId) clearPromptDraft(effectiveThreadId);
      const result = await onSubmit(prompt, opts, images);
      if (result === false) {
        hasSubmittedRef.current = false;
      }
      return result;
    },
    [onSubmit, effectiveThreadId, clearPromptDraft],
  );

  return (
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
      branches={newThreadBranches}
      branchesLoading={newThreadBranchesLoading}
      selectedBranch={selectedBranch}
      onSelectedBranchChange={setSelectedBranch}
      followUpBranches={followUpBranches}
      followUpSelectedBranch={followUpSelectedBranch}
      onFollowUpSelectedBranchChange={setFollowUpSelectedBranch}
      activeThreadBranch={activeThreadBranch}
      remoteUrl={remoteUrl}
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
      onEditorPaste={handleEditorPaste}
      onCheckoutPreflight={handleCheckoutPreflight}
    />
  );
});
