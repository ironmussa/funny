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
  Zap,
  GitBranch,
  Inbox,
  FileText,
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
// Textarea import available if needed
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { api } from '@/lib/api';
import { getContextWindow, getUnifiedModelOptions, parseUnifiedModel } from '@/lib/providers';
import { cn } from '@/lib/utils';
import { useDraftStore } from '@/stores/draft-store';
import { useProjectStore } from '@/stores/project-store';
import { useThreadStore } from '@/stores/thread-store';

import { ImageLightbox } from './ImageLightbox';
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

  const [prompt, setPrompt] = useState(initialPromptProp ?? '');

  // Expose setPrompt to parent via ref
  useEffect(() => {
    if (setPromptRef) {
      setPromptRef.current = setPrompt;
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

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const textareaCallbackRef = useCallback((node: HTMLTextAreaElement | null) => {
    textareaRef.current = node;
    node?.focus();
  }, []);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  // Track whether handleSubmit cleared the prompt so the unmount cleanup
  // doesn't accidentally save the stale value back into the draft store.
  const hasSubmittedRef = useRef(false);

  // Load initial prompt/images when props change (e.g. navigating to a backlog thread)
  useEffect(() => {
    if (initialPromptProp) setPrompt(initialPromptProp);
    if (initialImagesProp?.length) setImages(initialImagesProp);
  }, [initialPromptProp, initialImagesProp]);

  // Slash-command state
  const [skills, setSkills] = useState<Skill[]>([]);
  const [skillsLoaded, setSkillsLoaded] = useState(false);
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const [slashFilter, setSlashFilter] = useState('');
  const [slashIndex, setSlashIndex] = useState(0);
  const slashMenuRef = useRef<HTMLDivElement>(null);

  // File mention state
  const [showMentionMenu, setShowMentionMenu] = useState(false);
  const [mentionFilter, setMentionFilter] = useState('');
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionItems, setMentionItems] = useState<
    Array<{ path: string; type: 'file' | 'folder' }>
  >([]);
  const [mentionLoading, setMentionLoading] = useState(false);
  const [mentionTruncated, setMentionTruncated] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<string[]>([]);
  const [selectedFileTypes, setSelectedFileTypes] = useState<Record<string, 'file' | 'folder'>>({});
  const mentionMenuRef = useRef<HTMLDivElement>(null);
  const mentionStartPosRef = useRef<number>(-1);
  const loadFilesTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const selectedProjectId = useProjectStore((s) => s.selectedProjectId);
  const selectedThreadId = useThreadStore((s) => s.selectedThreadId);
  const effectiveThreadId = threadIdProp ?? selectedThreadId;

  // Draft persistence across thread switches
  const { setPromptDraft, clearPromptDraft } = useDraftStore();
  // Initialize to null so the mount effect always restores the draft for the current thread
  const prevThreadIdRef = useRef<string | null | undefined>(null);

  // Keep refs in sync so unmount cleanup can read the latest values
  const promptRef = useRef(prompt);
  const imagesRef = useRef(images);
  const selectedFilesRef = useRef(selectedFiles);
  const threadIdRef = useRef(effectiveThreadId);
  promptRef.current = prompt;
  imagesRef.current = images;
  selectedFilesRef.current = selectedFiles;
  threadIdRef.current = effectiveThreadId;

  // Save draft when switching away from a thread, restore when switching to a new one
  useEffect(() => {
    const prevId = prevThreadIdRef.current;
    prevThreadIdRef.current = effectiveThreadId;

    // Save draft for the thread we're leaving
    if (prevId && prevId !== effectiveThreadId) {
      const currentPrompt = textareaRef.current?.value ?? promptRef.current;
      setPromptDraft(prevId, currentPrompt, imagesRef.current, selectedFilesRef.current);
    }

    // Restore draft for the thread we're entering
    if (effectiveThreadId && effectiveThreadId !== prevId) {
      const draft = useDraftStore.getState().drafts[effectiveThreadId];
      setPrompt(draft?.prompt ?? initialPromptProp ?? '');
      setImages(draft?.images ?? initialImagesProp ?? []);
      setSelectedFiles(draft?.selectedFiles ?? []);
    } else if (!effectiveThreadId) {
      setPrompt('');
      setImages([]);
      setSelectedFiles([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only save/restore drafts on thread switch; prompt/images/selectedFiles are read via refs to avoid re-runs on every keystroke
  }, [effectiveThreadId]);

  // Save draft when the component unmounts (e.g. navigating to AllThreadsView)
  useEffect(() => {
    return () => {
      // Skip saving draft if the prompt was just submitted — the draft was
      // already cleared in handleSubmit and promptRef may still hold the
      // stale pre-submit value because React batches state updates.
      if (hasSubmittedRef.current) return;
      const threadId = threadIdRef.current;
      if (threadId) {
        const currentPrompt = textareaRef.current?.value ?? promptRef.current;
        setPromptDraft(threadId, currentPrompt, imagesRef.current, selectedFilesRef.current);
      }
    };
  }, [setPromptDraft]);

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

  // Reset skills cache when project changes
  useEffect(() => {
    setSkillsLoaded(false);
    setSkills([]);
  }, [selectedProjectId]);

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
          // Local mode: prioritize currentBranch (the branch actually checked out)
          // Worktree mode: prioritize project defaultBranch > git defaultBranch
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
          // Default to baseBranch (worktree source), then project defaultBranch, then git defaultBranch, then currentBranch
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

  // Fetch skills once when the menu first opens
  const loadSkills = useCallback(async () => {
    if (skillsLoaded) return;
    const projectPath = selectedProjectId
      ? projects.find((p) => p.id === selectedProjectId)?.path
      : undefined;
    const result = await api.listSkills(projectPath);
    if (result.isOk()) {
      // Deduplicate: if a skill exists at both global and project scope, keep only the project-level one
      const allSkills = result.value.skills ?? [];
      const deduped = new Map<string, Skill>();
      for (const skill of allSkills) {
        const existing = deduped.get(skill.name);
        if (!existing || skill.scope === 'project') {
          deduped.set(skill.name, skill);
        }
      }
      setSkills(Array.from(deduped.values()));
    } else {
      setSkills([]);
    }
    setSkillsLoaded(true);
  }, [skillsLoaded, selectedProjectId, projects]);

  // Filtered skills based on what user typed after /
  const filteredSkills = skills.filter((s) =>
    s.name.toLowerCase().includes(slashFilter.toLowerCase()),
  );

  // Slash-command start position ref (like mentionStartPosRef)
  const slashStartPosRef = useRef<number>(-1);

  // Detect slash command trigger at cursor position
  const handleSlashDetection = useCallback(
    (value: string, cursorPos: number) => {
      const textBeforeCursor = value.slice(0, cursorPos);
      // Match a `/` preceded by start-of-string or whitespace, followed by non-space chars
      const match = textBeforeCursor.match(/(^|[\s])\/(\S*)$/);
      if (match) {
        setSlashFilter(match[2]);
        setShowSlashMenu(true);
        setSlashIndex(0);
        slashStartPosRef.current = cursorPos - match[2].length - 1; // -1 for the `/`
        loadSkills();
      } else {
        setShowSlashMenu(false);
      }
    },
    [loadSkills],
  );

  // Scroll selected item into view
  useEffect(() => {
    if (!showSlashMenu || !slashMenuRef.current) return;
    const activeItem = slashMenuRef.current.children[slashIndex] as HTMLElement | undefined;
    activeItem?.scrollIntoView({ block: 'nearest' });
  }, [slashIndex, showSlashMenu]);

  const selectSkill = useCallback(
    (skill: Skill) => {
      const startPos = slashStartPosRef.current;
      setPrompt((prev) => {
        const before = prev.slice(0, startPos);
        // Skip past the `/` + whatever the user typed as filter
        const afterSlash = prev.slice(startPos + 1 + slashFilter.length);
        return `${before}/${skill.name} ${afterSlash}`;
      });
      setShowSlashMenu(false);
      textareaRef.current?.focus();
    },
    [slashFilter],
  );

  // Load files for @ mention with debounce
  const loadFiles = useCallback(
    (query: string) => {
      if (loadFilesTimeoutRef.current) clearTimeout(loadFilesTimeoutRef.current);
      loadFilesTimeoutRef.current = setTimeout(async () => {
        const path = cwdOverride || threadCwd;
        if (!path) return;
        setMentionLoading(true);
        const result = await api.browseFiles(path, query || undefined);
        if (result.isOk()) {
          // Normalize: server may return objects { path, type } or legacy strings
          const items = result.value.files.map((f) =>
            typeof f === 'string' ? { path: f, type: 'file' as const } : f,
          );
          setMentionItems(items);
          setMentionTruncated(result.value.truncated);
        }
        setMentionLoading(false);
      }, 150);
    },
    [cwdOverride, threadCwd],
  );

  // Handle @ mention trigger detection
  const handleMentionDetection = useCallback(
    (value: string, cursorPos: number) => {
      const textBeforeCursor = value.slice(0, cursorPos);
      const mentionMatch = textBeforeCursor.match(/@([^\s@]*)$/);
      if (mentionMatch) {
        const query = mentionMatch[1];
        setMentionFilter(query);
        setShowMentionMenu(true);
        setMentionIndex(0);
        mentionStartPosRef.current = cursorPos - mentionMatch[0].length;
        loadFiles(query);
      } else {
        setShowMentionMenu(false);
      }
    },
    [loadFiles],
  );

  // Select a file/folder from the mention menu (rerender-functional-setstate)
  const selectMentionFile = useCallback(
    (filePath: string, itemType: 'file' | 'folder' = 'file') => {
      const startPos = mentionStartPosRef.current;
      // Remove the @mention text — the file/folder is shown as a chip instead
      setPrompt((prev) => {
        const before = prev.slice(0, startPos);
        const afterCursor = prev.slice(startPos + mentionFilter.length + 1); // +1 for @
        // Collapse extra whitespace left behind
        return before + afterCursor.replace(/^\s+/, before.length > 0 ? ' ' : '');
      });
      setSelectedFiles((prev) => (prev.includes(filePath) ? prev : [...prev, filePath]));
      setSelectedFileTypes((prev) => ({ ...prev, [filePath]: itemType }));
      setShowMentionMenu(false);
      textareaRef.current?.focus();
    },
    [mentionFilter],
  );

  // Scroll mention menu selection into view
  useEffect(() => {
    if (!showMentionMenu || !mentionMenuRef.current) return;
    const activeItem = mentionMenuRef.current.children[mentionIndex] as HTMLElement | undefined;
    activeItem?.scrollIntoView({ block: 'nearest' });
  }, [mentionIndex, showMentionMenu]);

  // Focus and reset popup state when switching threads
  useEffect(() => {
    textareaRef.current?.focus();
    setShowMentionMenu(false);
    setShowSlashMenu(false);
    setMentionFilter('');
    setSlashFilter('');
    setMentionIndex(0);
    setSlashIndex(0);
    setMentionItems([]);
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
    if (!running) textareaRef.current?.focus();
  }, [running]);

  useEffect(() => {
    if (!loading) textareaRef.current?.focus();
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

  // Auto-resize textarea up to 35vh.  Wrapped in rAF so multiple keystrokes
  // within a single frame batch into one resize (avoids repeated forced reflows).
  const resizeRafRef = useRef(0);
  const resizeTextarea = useCallback(() => {
    cancelAnimationFrame(resizeRafRef.current);
    resizeRafRef.current = requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.style.height = 'auto';
      const maxHeight = window.innerHeight * 0.35;
      ta.style.height = `${Math.min(ta.scrollHeight, maxHeight)}px`;
      ta.style.overflowY = ta.scrollHeight > maxHeight ? 'auto' : 'hidden';
    });
  }, []);

  // Cleanup rAF on unmount
  useEffect(() => () => cancelAnimationFrame(resizeRafRef.current), []);

  // Resize on initial mount and when prompt changes externally (e.g. draft restore)
  useEffect(() => {
    resizeTextarea();
  }, [prompt, resizeTextarea]);

  const handleSubmit = async () => {
    if (loading) return;
    if (!prompt.trim() && images.length === 0) {
      toast.warning(t('prompt.emptyPrompt', 'Please enter a prompt before sending'));
      return;
    }

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
    const submittedPrompt = prompt;
    const submittedImages = images.length > 0 ? images : undefined;
    const submittedFiles =
      selectedFiles.length > 0
        ? selectedFiles.map((p) => ({ path: p, type: selectedFileTypes[p] || ('file' as const) }))
        : undefined;
    setPrompt('');
    setImages([]);
    setSelectedFiles([]);
    setSelectedFileTypes({});
    hasSubmittedRef.current = true;
    if (effectiveThreadId) clearPromptDraft(effectiveThreadId);
    textareaRef.current?.focus();

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
      setPrompt(submittedPrompt);
      setImages(submittedImages ?? []);
      setSelectedFiles(submittedFiles?.map((f) => f.path) ?? []);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Delete last chip on Backspace when cursor is at position 0 and textarea is empty
    if (e.key === 'Backspace' && selectedFiles.length > 0 && !showMentionMenu && !showSlashMenu) {
      const cursorPos = textareaRef.current?.selectionStart ?? 0;
      if (cursorPos === 0 && !prompt) {
        e.preventDefault();
        const lastFile = selectedFiles[selectedFiles.length - 1];
        setSelectedFiles((prev) => prev.slice(0, -1));
        setSelectedFileTypes((prev) => {
          const next = { ...prev };
          delete next[lastFile];
          return next;
        });
        return;
      }
    }

    // Handle @ mention menu navigation
    if (showMentionMenu && mentionItems.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMentionIndex((i) => (i + 1) % mentionItems.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMentionIndex((i) => (i - 1 + mentionItems.length) % mentionItems.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const item = mentionItems[mentionIndex];
        selectMentionFile(item.path, item.type);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setShowMentionMenu(false);
        return;
      }
    }

    // Handle slash menu navigation
    if (showSlashMenu && filteredSkills.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSlashIndex((i) => (i + 1) % filteredSkills.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSlashIndex((i) => (i - 1 + filteredSkills.length) % filteredSkills.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        selectSkill(filteredSkills[slashIndex]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setShowSlashMenu(false);
        return;
      }
    }

    // Shift+Tab: cycle through modes (plan → autoEdit → confirmEdit → plan)
    if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault();
      setMode((current) => {
        const idx = modes.findIndex((m) => m.value === current);
        return modes[(idx + 1) % modes.length].value;
      });
      return;
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handlePaste = async (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) {
          await addImageFile(file);
        }
      }
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();

    // Check if dragged items include files
    if (e.dataTransfer.types.includes('Files')) {
      setIsDragging(true);
    }
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();

    // Only set to false if we're leaving the textarea container itself
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
      // Handle images
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) {
          await addImageFile(file);
        }
      }
      // Handle file paths (from file explorer)
      else if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file) {
          // Get relative path if possible, or use absolute path
          const filePath = (file as any).path || file.name;

          // Add to selected files if not already added (shown as chip, not in prompt text)
          if (!selectedFiles.includes(filePath)) {
            setSelectedFiles((prev) => [...prev, filePath]);
          }
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
        // Non-image files go as chips (same as drag-and-drop)
        const filePath = (file as any).path || file.name;
        if (!selectedFiles.includes(filePath)) {
          setSelectedFiles((prev) => [...prev, filePath]);
        }
      }
    }

    // Reset input
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

        {/* Textarea + bottom toolbar */}
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
          {/* File/folder mention dropdown */}
          {showMentionMenu && (
            <div
              ref={mentionMenuRef}
              className="absolute bottom-full left-0 z-50 mb-1 max-h-52 w-full overflow-y-auto rounded-md border border-border bg-popover text-popover-foreground shadow-md"
            >
              {mentionLoading && mentionItems.length === 0 ? (
                <div className="px-3 py-2 text-xs text-muted-foreground">
                  {t('prompt.loadingFiles', 'Loading files\u2026')}
                </div>
              ) : mentionItems.length === 0 ? (
                <div className="px-3 py-2 text-xs text-muted-foreground">
                  {t('prompt.noFilesMatch', 'No files match')}
                </div>
              ) : (
                <>
                  {mentionItems.map((item, i) => (
                    <button
                      key={`${item.type}:${item.path}`}
                      data-testid={`mention-item-${item.path}`}
                      className={cn(
                        'w-full flex items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent transition-colors',
                        i === mentionIndex && 'bg-accent',
                        selectedFiles.includes(item.path) && 'text-primary',
                      )}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        selectMentionFile(item.path, item.type);
                      }}
                      onMouseEnter={() => setMentionIndex(i)}
                    >
                      {item.type === 'folder' ? (
                        <FolderOpen className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      ) : (
                        <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      )}
                      <span className="truncate font-mono text-xs">{item.path}</span>
                    </button>
                  ))}
                  {mentionTruncated && (
                    <div className="border-t border-border px-3 py-1.5 text-xs text-muted-foreground">
                      {t('prompt.moreFilesHint', 'Type to narrow results\u2026')}
                    </div>
                  )}
                </>
              )}
            </div>
          )}
          {/* Slash command dropdown */}
          {showSlashMenu && (
            <div
              ref={slashMenuRef}
              className="absolute bottom-full left-0 z-50 mb-1 max-h-52 w-full overflow-y-auto rounded-md border border-border bg-popover text-popover-foreground shadow-md"
            >
              {filteredSkills.length === 0 ? (
                <div className="px-3 py-2 text-xs text-muted-foreground">
                  {skillsLoaded ? t('skills.noSkillsFound') : t('prompt.loadingSkills')}
                </div>
              ) : (
                filteredSkills.map((skill, i) => (
                  <button
                    key={skill.name}
                    className={cn(
                      'w-full flex items-start gap-2 px-3 py-2 text-left text-sm hover:bg-accent transition-colors',
                      i === slashIndex && 'bg-accent',
                    )}
                    onMouseDown={(e) => {
                      e.preventDefault(); // prevent textarea blur
                      selectSkill(skill);
                    }}
                    onMouseEnter={() => setSlashIndex(i)}
                  >
                    <Zap className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0">
                      <div className="font-mono text-xs font-medium">/{skill.name}</div>
                      {skill.description && (
                        <div className="truncate text-xs text-muted-foreground">
                          {skill.description}
                        </div>
                      )}
                    </div>
                  </button>
                ))
              )}
            </div>
          )}
          {/* Textarea */}
          {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
          <div
            className="px-3 pt-2"
            onClick={() => textareaRef.current?.focus()}
          >
            <textarea
              ref={textareaCallbackRef}
              data-testid="prompt-textarea"
              aria-label={t('prompt.messageLabel', 'Message')}
              className="w-full resize-none bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
              style={{ minHeight: '1.5rem' }}
              placeholder={
                running
                  ? isQueueMode
                    ? t('thread.typeToQueue')
                    : t('thread.typeToInterrupt')
                  : defaultPlaceholder
              }
              value={prompt}
              onChange={(e) => {
                const value = e.target.value;
                const cursorPos = e.target.selectionStart ?? value.length;
                setPrompt(value);
                resizeTextarea();
                handleMentionDetection(value, cursorPos);
                handleSlashDetection(value, cursorPos);
              }}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              rows={1}
              disabled={loading}
            />
          </div>
          {/* File chips below textarea */}
          {selectedFiles.length > 0 && (
            <div className="flex flex-wrap gap-1 px-3 pb-1">
              {selectedFiles.map((file) => (
                <span
                  key={file}
                  data-testid={`selected-file-${file}`}
                  className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border/60 bg-muted/60 px-2 py-0.5 font-mono text-xs text-foreground/80"
                  title={file}
                >
                  {selectedFileTypes[file] === 'folder' ? (
                    <FolderOpen className="h-3 w-3 shrink-0 text-muted-foreground" />
                  ) : (
                    <FileText className="h-3 w-3 shrink-0 text-muted-foreground" />
                  )}
                  {file.split('/').pop()}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelectedFiles((prev) => prev.filter((f) => f !== file));
                      setSelectedFileTypes((prev) => {
                        const next = { ...prev };
                        delete next[file];
                        return next;
                      });
                    }}
                    aria-label={t('prompt.removeFile', 'Remove file')}
                    className="ml-0.5 rounded-sm hover:text-destructive"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
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
                {running && !prompt.trim() ? (
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
