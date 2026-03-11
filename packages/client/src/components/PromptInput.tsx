import type { ImageAttachment, QueuedMessage, Skill } from '@funny/shared';
import {
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  DEFAULT_PERMISSION_MODE,
  DEFAULT_THREAD_MODE,
} from '@funny/shared/models';
import {
  ArrowUp,
  ArrowLeft,
  Square,
  Loader2,
  Paperclip,
  X,
  GitBranch,
  Inbox,
  Globe,
  Github,
  FolderOpen,
  Copy,
  ListOrdered,
  Pencil,
  Trash2,
  Check,
  ChevronDown,
} from 'lucide-react';
import { useState, useRef, useEffect, useCallback, useMemo, memo } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { api } from '@/lib/api';
import { getContextWindow, getUnifiedModelOptions, parseUnifiedModel } from '@/lib/providers';
import { cn } from '@/lib/utils';
import { useDraftStore } from '@/stores/draft-store';
import { useProjectStore } from '@/stores/project-store';
import { useThreadStore } from '@/stores/thread-store';

import { ImageLightbox } from './ImageLightbox';
import type { PromptEditorHandle } from './prompt-editor/PromptEditor';
import { PromptEditor } from './prompt-editor/PromptEditor';
import { serializeEditorContent } from './prompt-editor/serialize';
import { BranchPicker } from './SearchablePicker';

// ── Lightweight Popover-based selectors ──────────────────────────
// Radix Select is slow to open (~900ms processing) due to item measurement,
// FocusScope traversal, and DismissableLayer setup. These use Popover instead,
// which is significantly lighter (no item measurement, no scroll-into-view logic).

const ModeSelect = memo(function ModeSelect({
  value,
  onChange,
  modes,
}: {
  value: string;
  onChange: (v: string) => void;
  modes: { value: string; label: string }[];
}) {
  const [open, setOpen] = useState(false);
  const currentLabel = modes.find((m) => m.value === value)?.label ?? value;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          data-testid="prompt-mode-select"
          tabIndex={-1}
          className="flex h-7 cursor-pointer items-center gap-1 rounded-md bg-transparent px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        >
          <span>{currentLabel}</span>
          <ChevronDown className="h-3 w-3 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        className="w-auto min-w-[8rem] p-1 data-[state=closed]:animate-none data-[state=open]:animate-none"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        {modes.map((m) => (
          <button
            key={m.value}
            className={cn(
              'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs outline-none transition-colors hover:bg-accent hover:text-accent-foreground',
              m.value === value && 'bg-accent text-accent-foreground',
            )}
            onClick={() => {
              onChange(m.value);
              setOpen(false);
            }}
          >
            {m.label}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
});

const ModelSelect = memo(function ModelSelect({
  value,
  onChange,
  groups,
}: {
  value: string;
  onChange: (v: string) => void;
  groups: ReturnType<typeof getUnifiedModelOptions>;
}) {
  const [open, setOpen] = useState(false);
  // Find current label
  let currentLabel = value;
  for (const g of groups) {
    const found = g.models.find((m) => m.value === value);
    if (found) {
      currentLabel = found.label;
      break;
    }
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          data-testid="prompt-model-select"
          tabIndex={-1}
          className="flex h-7 cursor-pointer items-center gap-1 rounded-md bg-transparent px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        >
          <span>{currentLabel}</span>
          <ChevronDown className="h-3 w-3 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        className="w-auto min-w-[10rem] p-1 data-[state=closed]:animate-none data-[state=open]:animate-none"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        {groups.map((group) => (
          <div key={group.provider}>
            <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground">
              {group.providerLabel}
            </div>
            {group.models.map((m) => (
              <button
                key={m.value}
                className={cn(
                  'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs outline-none transition-colors hover:bg-accent hover:text-accent-foreground',
                  m.value === value && 'bg-accent text-accent-foreground',
                )}
                onClick={() => {
                  onChange(m.value);
                  setOpen(false);
                }}
              >
                {m.label}
              </button>
            ))}
          </div>
        ))}
      </PopoverContent>
    </Popover>
  );
});

const ContextUsage = memo(function ContextUsage({
  provider,
  model,
  cumulativeTokens,
}: {
  provider: string;
  model: string;
  cumulativeTokens: number;
}) {
  const maxTokens = getContextWindow(provider, model);
  const cumulative = cumulativeTokens;
  const pct = maxTokens > 0 ? Math.min(100, (cumulative / maxTokens) * 100) : 0;
  const tokenK = Math.round(cumulative / 1000);
  const colorClass =
    pct > 80 ? 'text-red-500' : pct > 60 ? 'text-amber-500' : 'text-muted-foreground';
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn('cursor-default text-xs tabular-nums', colorClass)}>
          {pct.toFixed(0)}% used
        </span>
      </TooltipTrigger>
      <TooltipContent>
        Context: {tokenK}K / {Math.round(maxTokens / 1000)}K tokens
      </TooltipContent>
    </Tooltip>
  );
});

/** Parse a git remote URL into a friendly `owner/repo` display string. */
function formatRemoteUrl(url: string): string {
  // Handle SSH: git@github.com:user/repo.git
  const sshMatch = url.match(/[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
  if (sshMatch) return sshMatch[1];
  // Handle HTTPS: https://github.com/user/repo.git
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/^\//, '').replace(/\.git$/, '');
    return path;
  } catch {
    return url;
  }
}

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

  // Resolve effective defaults from project settings (hardcoded fallbacks)
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

  // ── TipTap editor ref ──
  const editorRef = useRef<PromptEditorHandle>(null);

  // Expose setPrompt to parent via ref (adapts to editor API)
  useEffect(() => {
    if (setPromptRef) {
      setPromptRef.current = (text: string) => {
        editorRef.current?.setContent(text);
      };
      return () => {
        setPromptRef.current = null;
      };
    }
  }, [setPromptRef]);

  const [unifiedModel, setUnifiedModel] = useState<string>(`${defaultProvider}:${defaultModel}`);
  const { provider, model } = useMemo(() => parseUnifiedModel(unifiedModel), [unifiedModel]);
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

  // Sync mode with active thread's permission mode — granular selectors to avoid
  // re-rendering when unrelated activeThread properties (e.g. messages) change.
  const activeThreadPermissionMode = useThreadStore((s) => s.activeThread?.permissionMode);
  const activeThreadWorktreePath = useThreadStore((s) => s.activeThread?.worktreePath);
  const activeThreadProvider = useThreadStore((s) => s.activeThread?.provider);
  const activeThreadModel = useThreadStore((s) => s.activeThread?.model);
  const activeThreadMode = useThreadStore((s) => s.activeThread?.mode);
  const activeThreadBranch = useThreadStore((s) => s.activeThread?.branch);
  const activeThreadBaseBranch = useThreadStore((s) => s.activeThread?.baseBranch);
  // Select primitive values instead of the contextUsage object to avoid
  // re-renders when the object reference changes but values stay the same.
  const contextCumulativeTokens = useThreadStore(
    (s) => s.activeThread?.contextUsage?.cumulativeInputTokens ?? 0,
  );
  const [newThreadBranches, setNewThreadBranches] = useState<string[]>([]);
  const [newThreadBranchesLoading, setNewThreadBranchesLoading] = useState(false);
  const [selectedBranch, setSelectedBranch] = useState<string>('');
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [sendToBacklog, setSendToBacklog] = useState(false);
  const [_localCurrentBranch, setLocalCurrentBranch] = useState<string | null>(null);
  // Git remote origin URL
  const [remoteUrl, setRemoteUrl] = useState<string | null>(null);
  // For existing threads in local mode: allow creating a worktree
  const [createWorktreeForFollowUp, _setCreateWorktreeForFollowUp] = useState(false);
  const [followUpBranches, setFollowUpBranches] = useState<string[]>([]);
  const [followUpSelectedBranch, setFollowUpSelectedBranch] = useState<string>('');
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessage[]>([]);
  const [queueLoading, setQueueLoading] = useState(false);
  const [queueActionMessageId, setQueueActionMessageId] = useState<string | null>(null);
  const [editingQueuedMessageId, setEditingQueuedMessageId] = useState<string | null>(null);
  const [editingQueuedMessageContent, setEditingQueuedMessageContent] = useState('');

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  // Track whether handleSubmit cleared the prompt so the unmount cleanup
  // doesn't accidentally save the stale value back into the draft store.
  const hasSubmittedRef = useRef(false);
  // Track whether the editor is empty (updated via onChange)
  const [editorEmpty, setEditorEmpty] = useState(true);

  // Load initial prompt/images when props change (e.g. navigating to a backlog thread)
  useEffect(() => {
    if (initialPromptProp) editorRef.current?.setContent(initialPromptProp);
    if (initialImagesProp?.length) setImages(initialImagesProp);
  }, [initialPromptProp, initialImagesProp]);

  const selectedProjectId = useProjectStore((s) => s.selectedProjectId);
  const selectedThreadId = useThreadStore((s) => s.selectedThreadId);
  const effectiveThreadId = threadIdProp ?? selectedThreadId;

  // Draft persistence across thread switches
  const { setEditorDraft, clearPromptDraft } = useDraftStore();
  // Initialize to null so the mount effect always restores the draft for the current thread
  const prevThreadIdRef = useRef<string | null | undefined>(null);

  // Keep refs in sync so unmount cleanup can read the latest values
  const imagesRef = useRef(images);
  const threadIdRef = useRef(effectiveThreadId);
  imagesRef.current = images;
  threadIdRef.current = effectiveThreadId;

  // Save draft when switching away from a thread, restore when switching to a new one
  useEffect(() => {
    const prevId = prevThreadIdRef.current;
    prevThreadIdRef.current = effectiveThreadId;

    // Save draft for the thread we're leaving
    if (prevId && prevId !== effectiveThreadId) {
      const editorJSON = editorRef.current?.getJSON();
      if (editorJSON) {
        setEditorDraft(prevId, editorJSON, imagesRef.current);
      }
    }

    // Restore draft for the thread we're entering
    if (effectiveThreadId && effectiveThreadId !== prevId) {
      const draft = useDraftStore.getState().drafts[effectiveThreadId];
      if (draft?.editorContent) {
        editorRef.current?.setContent(draft.editorContent);
      } else if (draft?.prompt) {
        // Legacy fallback: restore string-based draft
        editorRef.current?.setContent(draft.prompt);
      } else if (initialPromptProp) {
        editorRef.current?.setContent(initialPromptProp);
      } else {
        editorRef.current?.clear();
      }
      setImages(draft?.images ?? initialImagesProp ?? []);
    } else if (!effectiveThreadId) {
      editorRef.current?.clear();
      setImages([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only save/restore drafts on thread switch
  }, [effectiveThreadId]);

  // Save draft when the component unmounts (e.g. navigating to AllThreadsView)
  useEffect(() => {
    const editorRefCurrent = editorRef.current;
    const imagesRefCurrent = imagesRef.current;
    return () => {
      if (hasSubmittedRef.current) return;
      const threadId = threadIdRef.current;
      if (threadId) {
        const editorJSON = editorRefCurrent?.getJSON();
        if (editorJSON) {
          setEditorDraft(threadId, editorJSON, imagesRefCurrent);
        }
      }
    };
  }, [setEditorDraft]);

  // Derive project path and manage cwd override
  const effectiveProjectIdForPath = propProjectId || selectedProjectId;
  const projectPath = useMemo(
    () =>
      effectiveProjectIdForPath
        ? (projects.find((p) => p.id === effectiveProjectIdForPath)?.path ?? '')
        : '',
    [effectiveProjectIdForPath, projects],
  );
  const [cwdOverride, setCwdOverride] = useState<string | null>(null);
  const threadCwd = activeThreadWorktreePath || projectPath;
  const effectiveCwd = cwdOverride || threadCwd;

  // Reset cwd override when thread or project changes
  useEffect(() => {
    setCwdOverride(null);
  }, [selectedProjectId, effectiveThreadId]);

  // Sync mode with active thread's permission mode when thread changes
  useEffect(() => {
    if (!isNewThread && activeThreadPermissionMode) {
      setMode(activeThreadPermissionMode);
    } else if (isNewThread) {
      setMode(defaultPermissionMode);
    }
  }, [isNewThread, activeThreadPermissionMode, defaultPermissionMode]);

  // Sync unified model with active thread's provider+model when thread changes
  useEffect(() => {
    if (!isNewThread && activeThreadProvider && activeThreadModel) {
      setUnifiedModel(`${activeThreadProvider}:${activeThreadModel}`);
    } else if (isNewThread) {
      setUnifiedModel(`${defaultProvider}:${defaultModel}`);
    }
  }, [isNewThread, activeThreadProvider, activeThreadModel, defaultProvider, defaultModel]);

  // Fetch branches for new thread mode
  const effectiveProjectId = propProjectId || selectedProjectId;
  const projectDefaultBranch = effectiveProjectId
    ? projects.find((p) => p.id === effectiveProjectId)?.defaultBranch
    : undefined;
  // Track currentBranch from the API for local mode defaults
  const [gitCurrentBranch, setGitCurrentBranch] = useState<string | null>(null);
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

  // Fetch current branch for local mode threads without a saved branch
  useEffect(() => {
    if (!isNewThread && activeThreadMode === 'local' && !activeThreadBranch && selectedProjectId) {
      (async () => {
        const result = await api.listBranches(selectedProjectId);
        if (result.isOk()) {
          setLocalCurrentBranch(result.value.currentBranch);
        } else {
          setLocalCurrentBranch(null);
        }
      })();
    } else {
      setLocalCurrentBranch(null);
    }
  }, [isNewThread, activeThreadMode, activeThreadBranch, selectedProjectId]);

  // Fetch git remote origin URL for display
  useEffect(() => {
    if (projectPath) {
      (async () => {
        const result = await api.remoteUrl(projectPath);
        if (result.isOk()) {
          setRemoteUrl(result.value.url);
        } else {
          setRemoteUrl(null);
        }
      })();
    } else {
      setRemoteUrl(null);
    }
  }, [projectPath]);

  // Fetch branches for follow-up mode (all thread types)
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- projects is stable from store; adding it would loop
  }, [isNewThread, selectedProjectId, activeThreadBaseBranch]);

  // ── Skills loader for slash commands ──
  const skillsCacheRef = useRef<Skill[] | null>(null);

  // Reset skills cache when project changes
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

  // Focus editor when switching threads or when running/loading changes
  useEffect(() => {
    editorRef.current?.focus();
  }, [effectiveThreadId]);

  useEffect(() => {
    if (!effectiveThreadId) {
      setQueuedMessages([]);
      setQueueLoading(false);
      setQueueActionMessageId(null);
      setEditingQueuedMessageId(null);
      setEditingQueuedMessageContent('');
      return;
    }

    let cancelled = false;
    setQueueLoading(true);

    void (async () => {
      const result = await api.listQueue(effectiveThreadId);
      if (cancelled) return;

      if (result.isOk()) {
        setQueuedMessages(result.value);
        setEditingQueuedMessageId((current) => {
          if (!current) return current;
          const stillExists = result.value.some((message) => message.id === current);
          if (!stillExists) setEditingQueuedMessageContent('');
          return stillExists ? current : null;
        });
      } else {
        setQueuedMessages([]);
      }

      setQueueLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [effectiveThreadId, queuedCount]);

  useEffect(() => {
    if (!running) editorRef.current?.focus();
  }, [running]);

  useEffect(() => {
    if (!loading) editorRef.current?.focus();
  }, [loading]);

  const handleQueueEditStart = useCallback((message: QueuedMessage) => {
    setEditingQueuedMessageId(message.id);
    setEditingQueuedMessageContent(message.content);
  }, []);

  const handleQueueEditCancel = useCallback(() => {
    setEditingQueuedMessageId(null);
    setEditingQueuedMessageContent('');
  }, []);

  const handleQueueEditSave = useCallback(
    async (messageId: string) => {
      if (!effectiveThreadId) return;

      const nextContent = editingQueuedMessageContent.trim();
      if (!nextContent) {
        toast.warning(t('prompt.emptyPrompt', 'Please enter a prompt before sending'));
        return;
      }

      setQueueActionMessageId(messageId);
      const result = await api.updateQueuedMessage(
        effectiveThreadId,
        messageId,
        editingQueuedMessageContent,
      );

      if (result.isOk()) {
        setQueuedMessages((prev) =>
          prev.map((message) =>
            message.id === messageId
              ? { ...message, content: editingQueuedMessageContent }
              : message,
          ),
        );
        setEditingQueuedMessageId(null);
        setEditingQueuedMessageContent('');
      } else {
        toast.error(result.error.message);
      }

      setQueueActionMessageId((current) => (current === messageId ? null : current));
    },
    [editingQueuedMessageContent, effectiveThreadId, t],
  );

  const handleQueueDelete = useCallback(
    async (messageId: string) => {
      if (!effectiveThreadId) return;

      setQueueActionMessageId(messageId);
      const result = await api.cancelQueuedMessage(effectiveThreadId, messageId);

      if (result.isOk()) {
        setQueuedMessages((prev) => prev.filter((message) => message.id !== messageId));
        if (editingQueuedMessageId === messageId) {
          setEditingQueuedMessageId(null);
          setEditingQueuedMessageContent('');
        }
      } else {
        toast.error(result.error.message);
      }

      setQueueActionMessageId((current) => (current === messageId ? null : current));
    },
    [editingQueuedMessageId, effectiveThreadId],
  );

  const handleSubmit = useCallback(async () => {
    if (loading) return;

    // Serialize editor content to extract text + file references
    const editorJSON = editorRef.current?.getJSON();
    const isEmpty = editorRef.current?.isEmpty() ?? true;
    if (isEmpty && images.length === 0) {
      toast.warning(t('prompt.emptyPrompt', 'Please enter a prompt before sending'));
      return;
    }

    const serialized = editorJSON
      ? serializeEditorContent(editorJSON)
      : { text: '', fileReferences: [] };

    // Pre-flight checkout validation for local mode with a different branch
    if (
      isNewThread &&
      !createWorktree &&
      effectiveProjectId &&
      selectedBranch &&
      gitCurrentBranch &&
      selectedBranch !== gitCurrentBranch
    ) {
      const preflight = await api.checkoutPreflight(effectiveProjectId, selectedBranch);
      if (preflight.isOk() && !preflight.value.canCheckout) {
        const files = preflight.value.conflictingFiles?.join(', ') || '';
        toast.error(
          t('prompt.checkoutBlocked', {
            branch: selectedBranch,
            currentBranch: gitCurrentBranch,
            files,
          }),
          { duration: 8000 },
        );
        return;
      }
    }

    // Capture current values and clear immediately for responsive UX
    const submittedPrompt = serialized.text;
    const submittedImages = images.length > 0 ? images : undefined;
    const submittedFiles =
      serialized.fileReferences.length > 0 ? serialized.fileReferences : undefined;
    editorRef.current?.clear();
    setImages([]);
    setEditorEmpty(true);
    hasSubmittedRef.current = true;
    if (effectiveThreadId) clearPromptDraft(effectiveThreadId);
    editorRef.current?.focus();

    const result = await onSubmit(
      submittedPrompt,
      {
        provider,
        model,
        mode,
        ...(isNewThread
          ? {
              threadMode: createWorktree ? 'worktree' : 'local',
              runtime: runtime,
              baseBranch: selectedBranch || undefined,
              sendToBacklog,
            }
          : createWorktreeForFollowUp
            ? {
                threadMode: 'worktree',
                baseBranch: followUpSelectedBranch || undefined,
              }
            : { baseBranch: followUpSelectedBranch || undefined }),
        cwd: cwdOverride || undefined,
        fileReferences: submittedFiles,
      },
      submittedImages,
    );
    if (result === false) {
      // Restore on failure
      hasSubmittedRef.current = false;
      if (editorJSON) editorRef.current?.setContent(editorJSON);
      setImages(submittedImages ?? []);
    }
  }, [
    loading,
    images,
    t,
    isNewThread,
    createWorktree,
    effectiveProjectId,
    selectedBranch,
    gitCurrentBranch,
    effectiveThreadId,
    clearPromptDraft,
    onSubmit,
    provider,
    model,
    mode,
    runtime,
    sendToBacklog,
    createWorktreeForFollowUp,
    followUpSelectedBranch,
    cwdOverride,
  ]);

  const handleEditorPaste = useCallback(async (e: ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) {
          await addImageFile(file);
        }
      }
    }
  }, []);

  const handleEditorChange = useCallback(() => {
    setEditorEmpty(editorRef.current?.isEmpty() ?? true);
  }, []);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();

    if (e.dataTransfer.types.includes('Files')) {
      setIsDragging(true);
    }
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();

    if (e.currentTarget === e.target) {
      setIsDragging(false);
    }
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    if (loading) return;

    const items = e.dataTransfer?.items;
    if (!items) return;

    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) {
          await addImageFile(file);
        }
      }
    }
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;

    for (const file of Array.from(files)) {
      if (file.type.startsWith('image/')) {
        await addImageFile(file);
      } else {
        // Non-image files: insert as file mention chip in the editor
        const filePath = (file as any).path || file.name;
        editorRef.current?.insertFileMention(filePath, 'file');
      }
    }

    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const addImageFile = async (file: File): Promise<void> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = (reader.result as string).split(',')[1];
        const mediaType = file.type as ImageAttachment['source']['media_type'];

        setImages((prev) => [
          ...prev,
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: mediaType,
              data: base64,
            },
          },
        ]);
        resolve();
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  };

  const removeImage = (index: number) => {
    setImages((prev) => prev.filter((_, i) => i !== index));
  };

  const defaultPlaceholder = placeholder ?? t('thread.describeTaskDefault');

  const editorPlaceholder = running
    ? isQueueMode
      ? t('thread.typeToQueue')
      : t('thread.typeToInterrupt')
    : defaultPlaceholder;

  return (
    <div className="border-border px-4 py-3">
      <div className="mx-auto w-full min-w-0 max-w-3xl">
        {/* Image previews */}
        {images.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {images.map((img, idx) => (
              <div key={`preview-${idx}`} className="group relative">
                <img
                  src={`data:${img.source.media_type};base64,${img.source.data}`}
                  alt={`Attachment ${idx + 1}`}
                  className="h-20 max-w-48 cursor-pointer rounded border border-input object-contain transition-opacity hover:opacity-80"
                  onClick={() => {
                    setLightboxIndex(idx);
                    setLightboxOpen(true);
                  }}
                />
                <button
                  onClick={() => removeImage(idx)}
                  aria-label={t('prompt.removeImage', 'Remove image')}
                  className="absolute -right-1 -top-1 rounded-full bg-destructive p-0.5 text-destructive-foreground opacity-0 transition-opacity group-hover:opacity-100"
                  disabled={loading}
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Image lightbox */}
        <ImageLightbox
          images={images.map((img, idx) => ({
            src: `data:${img.source.media_type};base64,${img.source.data}`,
            alt: `Attachment ${idx + 1}`,
          }))}
          initialIndex={lightboxIndex}
          open={lightboxOpen}
          onClose={() => setLightboxOpen(false)}
        />

        {/* Queue indicator */}
        {(queuedCount > 0 || queuedMessages.length > 0) && (
          <div
            data-testid="queue-indicator"
            className="space-y-2 rounded-md border border-border/40 px-2.5 py-2"
          >
            <div className="flex items-center gap-1.5">
              <ListOrdered className="h-3 w-3 shrink-0 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">
                {(queuedMessages.length > 0 ? queuedMessages.length : queuedCount) === 1
                  ? t('prompt.queuedOne', '1 message in queue')
                  : t('prompt.queuedMany', '{{count}} messages in queue', {
                      count: queuedMessages.length > 0 ? queuedMessages.length : queuedCount,
                    })}
              </span>
            </div>

            {queueLoading ? (
              <div className="flex items-center gap-2 rounded-md border border-dashed border-border/60 bg-background/60 px-3 py-2 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                {t('prompt.loadingQueuedMessages', 'Loading queued messages...')}
              </div>
            ) : (
              <div className="divide-y divide-border [&>*]:bg-transparent">
                {queuedMessages.map((message, index) => {
                  const isEditing = editingQueuedMessageId === message.id;
                  const isBusy = queueActionMessageId === message.id;

                  return (
                    <div
                      key={message.id}
                      data-testid={`queue-item-${message.id}`}
                      className="bg-transparent px-1 py-1 first:pt-0 last:pb-0"
                    >
                      {isEditing ? (
                        <div className="flex items-center gap-2">
                          <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                            #{index + 1}
                          </span>
                          <Input
                            data-testid={`queue-edit-textarea-${message.id}`}
                            value={editingQueuedMessageContent}
                            onChange={(event) => setEditingQueuedMessageContent(event.target.value)}
                            disabled={isBusy}
                            className="h-7 flex-1 bg-background text-xs"
                          />
                          <div className="flex shrink-0 items-center gap-0.5">
                            <Button
                              data-testid={`queue-save-${message.id}`}
                              type="button"
                              size="icon-xs"
                              onClick={() => handleQueueEditSave(message.id)}
                              disabled={isBusy}
                              aria-label={t('prompt.saveQueuedMessage', 'Save')}
                              title={t('prompt.saveQueuedMessage', 'Save')}
                              className="text-muted-foreground hover:text-foreground"
                            >
                              {isBusy ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                              ) : (
                                <Check className="h-3 w-3" />
                              )}
                            </Button>
                            <Button
                              data-testid={`queue-cancel-edit-${message.id}`}
                              type="button"
                              variant="ghost"
                              size="icon-xs"
                              onClick={handleQueueEditCancel}
                              disabled={isBusy}
                              aria-label={t('prompt.cancelQueuedEdit', 'Cancel')}
                              title={t('prompt.cancelQueuedEdit', 'Cancel')}
                              className="text-muted-foreground hover:text-foreground"
                            >
                              <X className="h-3 w-3" />
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2">
                          <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                            #{index + 1}
                          </span>
                          <p
                            className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
                            title={message.content}
                          >
                            {message.content}
                          </p>
                          <div className="flex shrink-0 items-center gap-0.5">
                            <Button
                              data-testid={`queue-edit-${message.id}`}
                              type="button"
                              variant="ghost"
                              size="icon-xs"
                              onClick={() => handleQueueEditStart(message)}
                              disabled={isBusy}
                              aria-label={t('prompt.editQueuedMessage', 'Edit')}
                              title={t('prompt.editQueuedMessage', 'Edit')}
                              className="text-muted-foreground hover:text-foreground"
                            >
                              <Pencil className="h-3 w-3" />
                            </Button>
                            <Button
                              data-testid={`queue-delete-${message.id}`}
                              type="button"
                              variant="ghost"
                              size="icon-xs"
                              onClick={() => handleQueueDelete(message.id)}
                              disabled={isBusy}
                              aria-label={t('prompt.deleteQueuedMessage', 'Delete')}
                              title={t('prompt.deleteQueuedMessage', 'Delete')}
                              className="text-destructive hover:text-destructive"
                            >
                              {isBusy ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                              ) : (
                                <Trash2 className="h-3 w-3" />
                              )}
                            </Button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Editor + bottom toolbar */}
        <div
          className={cn(
            'relative rounded-md border bg-input/80',
            isDragging
              ? 'border-primary border-2 ring-2 ring-primary/20'
              : 'border-border/80 focus-within:border-ring',
          )}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {/* TipTap Editor */}
          {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
          <div className="px-3 pt-2" onClick={() => editorRef.current?.focus()}>
            <PromptEditor
              ref={editorRef}
              placeholder={editorPlaceholder}
              disabled={loading}
              onSubmit={handleSubmit}
              onChange={handleEditorChange}
              onPaste={handleEditorPaste}
              cwd={effectiveCwd}
              loadSkills={loadSkillsForEditor}
            />
          </div>
          {/* Bottom toolbar */}
          <input
            ref={fileInputRef}
            data-testid="prompt-file-input"
            type="file"
            multiple
            className="hidden"
            onChange={handleFileSelect}
            disabled={loading || running}
          />
          {/* Bottom toolbar — single row */}
          <div className="px-2 py-2.5">
            <div className="no-scrollbar flex h-9 items-center gap-1 overflow-x-auto">
              <Button
                data-testid="prompt-attach"
                onClick={() => fileInputRef.current?.click()}
                variant="ghost"
                size="icon-sm"
                tabIndex={-1}
                aria-label={t('prompt.attach')}
                disabled={loading}
                className="text-muted-foreground hover:text-foreground"
              >
                <Paperclip className="h-4 w-4" />
              </Button>
              <ModeSelect value={mode} onChange={setMode} modes={modes} />
              {/* Model + send — always visible, pushed right */}
              <div className="ml-auto flex shrink-0 items-center gap-1">
                {!isNewThread && (
                  <ContextUsage
                    provider={activeThreadProvider ?? provider ?? DEFAULT_PROVIDER}
                    model={activeThreadModel ?? model ?? DEFAULT_MODEL}
                    cumulativeTokens={contextCumulativeTokens}
                  />
                )}
                <ModelSelect
                  value={unifiedModel}
                  onChange={setUnifiedModel}
                  groups={unifiedModelGroups}
                />
                {running && editorEmpty ? (
                  <Button
                    data-testid="prompt-stop"
                    onClick={onStop}
                    variant="destructive"
                    size="icon-sm"
                    tabIndex={-1}
                    aria-label={t('prompt.stopAgent')}
                  >
                    <Square className="h-3.5 w-3.5" />
                  </Button>
                ) : (
                  <Button
                    data-testid="prompt-send"
                    onClick={handleSubmit}
                    disabled={loading}
                    size="icon-sm"
                    tabIndex={-1}
                    aria-label={
                      running && isQueueMode
                        ? t('prompt.queueMessage')
                        : t('prompt.send', 'Send message')
                    }
                  >
                    {loading ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <ArrowUp className="h-3.5 w-3.5" />
                    )}
                  </Button>
                )}
              </div>
            </div>
          </div>
          {/* Separator + Bottom bar — different content for new thread vs follow-up */}
          <div className="border-t border-border px-2 py-1.5">
            {isNewThread ? (
              <div className="no-scrollbar flex items-center gap-1 overflow-x-auto">
                {remoteUrl && (
                  <span className="flex max-w-[200px] shrink-0 items-center gap-1 truncate px-2 py-1 text-xs text-muted-foreground">
                    {remoteUrl.includes('github.com') ? (
                      <Github className="h-3 w-3 shrink-0" />
                    ) : (
                      <Globe className="h-3 w-3 shrink-0" />
                    )}
                    <span className="truncate font-mono">{formatRemoteUrl(remoteUrl)}</span>
                  </span>
                )}
                {newThreadBranchesLoading ? (
                  <span className="flex items-center gap-1 px-2 py-1 text-xs text-muted-foreground">
                    <GitBranch className="h-3 w-3 shrink-0" />
                    <Loader2 className="h-3 w-3 animate-spin" />
                  </span>
                ) : (
                  newThreadBranches.length > 0 && (
                    <BranchPicker
                      branches={newThreadBranches}
                      selected={selectedBranch}
                      onChange={setSelectedBranch}
                    />
                  )
                )}
                <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
                  <Switch
                    data-testid="prompt-worktree-switch"
                    checked={createWorktree}
                    onCheckedChange={setCreateWorktree}
                    tabIndex={-1}
                    className="h-4 w-7 data-[state=checked]:bg-primary data-[state=unchecked]:bg-input [&>span]:h-3 [&>span]:w-3 [&>span]:data-[state=checked]:translate-x-3"
                  />
                  <span>{t('thread.mode.worktree')}</span>
                </label>
                {hasLauncher && (
                  <ModeSelect
                    value={runtime}
                    onChange={(v) => setRuntime(v as 'local' | 'remote')}
                    modes={[
                      { value: 'local', label: 'Local' },
                      { value: 'remote', label: 'Remote' },
                    ]}
                  />
                )}
                {showBacklog && (
                  <button
                    data-testid="prompt-backlog-toggle"
                    onClick={() => setSendToBacklog((v) => !v)}
                    tabIndex={-1}
                    className={cn(
                      'flex items-center gap-1 pl-2 py-1 text-xs rounded transition-colors shrink-0 ml-auto',
                      sendToBacklog
                        ? 'bg-primary/10 text-primary'
                        : 'text-muted-foreground hover:text-foreground hover:bg-muted',
                    )}
                    title={t('prompt.sendToBacklog')}
                  >
                    <Inbox className="h-3 w-3" />
                    {t('prompt.backlog')}
                  </button>
                )}
              </div>
            ) : (
              <div className="flex flex-col">
                {effectiveCwd && (
                  <div className="no-scrollbar flex items-center gap-1 overflow-x-auto">
                    <span className="group/cwd flex max-w-[400px] shrink-0 items-center gap-1 truncate px-2 py-1 text-xs text-muted-foreground">
                      <FolderOpen className="h-3 w-3 shrink-0" />
                      <span className="truncate font-mono">{effectiveCwd}</span>
                      <button
                        type="button"
                        className="shrink-0 opacity-0 transition-colors hover:text-foreground group-hover/cwd:opacity-100"
                        onClick={() => {
                          navigator.clipboard.writeText(effectiveCwd);
                          toast.success('Path copied');
                        }}
                      >
                        <Copy className="h-3 w-3" />
                      </button>
                    </span>
                  </div>
                )}
                {(followUpBranches.length > 0 || activeThreadBranch) && (
                  <div className="no-scrollbar flex items-center gap-1 overflow-x-auto">
                    {followUpBranches.length > 0 && (
                      <BranchPicker
                        branches={followUpBranches}
                        selected={followUpSelectedBranch}
                        onChange={setFollowUpSelectedBranch}
                      />
                    )}
                    {activeThreadBranch && followUpBranches.length > 0 && (
                      <ArrowLeft className="h-3 w-3 shrink-0 text-muted-foreground" />
                    )}
                    {activeThreadBranch && (
                      <button
                        type="button"
                        className="flex shrink-0 items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted"
                        onClick={() => {
                          navigator.clipboard.writeText(activeThreadBranch);
                          toast.success(t('prompt.branchCopied', 'Branch copied'));
                        }}
                      >
                        <GitBranch className="h-3 w-3 shrink-0" />
                        <span className="font-mono font-medium text-foreground">
                          {activeThreadBranch}
                        </span>
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
});
