import type { ImageAttachment, Skill } from '@funny/shared';
import {
  ArrowUp,
  ArrowLeft,
  Square,
  Loader2,
  Paperclip,
  X,
  Zap,
  GitBranch,
  Check,
  Inbox,
  FileText,
  Globe,
  Github,
  FolderOpen,
  Copy,
} from 'lucide-react';
import { useState, useRef, useEffect, useCallback, useMemo, memo } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { api } from '@/lib/api';
import { getContextWindow, getUnifiedModelOptions, parseUnifiedModel } from '@/lib/providers';
import { cn } from '@/lib/utils';
import { useDraftStore } from '@/stores/draft-store';
import { useProjectStore } from '@/stores/project-store';
import { useThreadStore } from '@/stores/thread-store';

import { ImageLightbox } from './ImageLightbox';

interface SearchablePickerItem {
  key: string;
  label: string;
  isSelected: boolean;
  detail?: string;
  badge?: string;
}

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

function SearchablePicker({
  items,
  label,
  displayValue,
  searchPlaceholder,
  noMatchText,
  emptyText,
  loadingText,
  loading,
  onSelect,
  onCopy,
  triggerClassName,
  triggerTitle,
  width = 'w-[28rem]',
}: {
  items: SearchablePickerItem[];
  label: string;
  displayValue: string;
  searchPlaceholder: string;
  noMatchText: string;
  emptyText?: string;
  loadingText?: string;
  loading?: boolean;
  onSelect: (key: string) => void;
  onCopy?: (key: string) => void;
  triggerClassName?: string;
  triggerTitle?: string;
  width?: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [highlightIndex, setHighlightIndex] = useState(-1);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const filtered = search
    ? items.filter((item) => item.label.toLowerCase().includes(search.toLowerCase()))
    : items;

  // Reset highlight when filtered list changes
  useEffect(() => {
    setHighlightIndex(-1);
  }, [search]);

  // Scroll selected item into view when popover opens
  useEffect(() => {
    if (open && !search) {
      const selectedIndex = filtered.findIndex((item) => item.isSelected);
      if (selectedIndex >= 0) {
        requestAnimationFrame(() => {
          itemRefs.current[selectedIndex]?.scrollIntoView({ block: 'nearest' });
        });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only scroll into view on open; filtered/search are read but should not trigger re-runs
  }, [open]);

  const handleSearchKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (filtered.length > 0) {
        setHighlightIndex(0);
        itemRefs.current[0]?.focus();
        itemRefs.current[0]?.scrollIntoView({ block: 'nearest' });
      }
    }
  };

  const handleItemKeyDown = (e: React.KeyboardEvent, i: number) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (i < filtered.length - 1) {
        setHighlightIndex(i + 1);
        itemRefs.current[i + 1]?.focus();
        itemRefs.current[i + 1]?.scrollIntoView({ block: 'nearest' });
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (i > 0) {
        setHighlightIndex(i - 1);
        itemRefs.current[i - 1]?.focus();
        itemRefs.current[i - 1]?.scrollIntoView({ block: 'nearest' });
      } else {
        setHighlightIndex(-1);
        searchInputRef.current?.focus();
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      onSelect(filtered[i].key);
      setOpen(false);
      setSearch('');
    }
  };

  return (
    <Popover
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) {
          setSearch('');
          setHighlightIndex(-1);
        }
      }}
    >
      <PopoverTrigger asChild>
        <button
          className={
            triggerClassName ??
            'flex max-w-[300px] items-center gap-1 truncate rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground'
          }
          title={triggerTitle}
          tabIndex={-1}
        >
          <GitBranch className="h-3 w-3 shrink-0" />
          <span className="truncate font-mono">{displayValue}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        className={cn(width, 'p-0 flex flex-col overflow-hidden')}
        style={{ maxHeight: 'min(70vh, 520px)' }}
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          searchInputRef.current?.focus();
        }}
      >
        <div className="border-b border-border bg-muted/30 px-3 py-2">
          <p className="text-sm font-medium text-muted-foreground">{label}</p>
        </div>
        <div
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1"
          ref={listRef}
          style={{ maxHeight: 'min(60vh, 440px)' }}
        >
          {loading && items.length === 0 && loadingText && (
            <p className="py-3 text-center text-sm text-muted-foreground">{loadingText}</p>
          )}
          {!loading && items.length === 0 && emptyText && (
            <p className="py-3 text-center text-sm text-muted-foreground">{emptyText}</p>
          )}
          {!loading && items.length > 0 && filtered.length === 0 && (
            <p className="py-3 text-center text-sm text-muted-foreground">{noMatchText}</p>
          )}
          {filtered.map((item, i) => (
            <div key={item.key} className="group/item relative">
              <button
                ref={(el) => {
                  itemRefs.current[i] = el;
                }}
                onClick={() => {
                  onSelect(item.key);
                  setOpen(false);
                  setSearch('');
                }}
                onKeyDown={(e) => handleItemKeyDown(e, i)}
                onFocus={() => setHighlightIndex(i)}
                onMouseEnter={() => {
                  setHighlightIndex(i);
                  itemRefs.current[i]?.focus();
                }}
                className={cn(
                  'w-full flex items-center gap-2 rounded py-1.5 pl-2 text-left text-xs transition-colors outline-none',
                  onCopy ? 'pr-7' : 'pr-2',
                  i === highlightIndex
                    ? 'bg-accent text-foreground'
                    : item.isSelected
                      ? 'bg-accent/50 text-foreground'
                      : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                )}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate font-mono font-medium">{item.label}</span>
                    {item.badge && (
                      <span className="rounded bg-muted px-1 py-0.5 text-[9px] leading-none text-muted-foreground">
                        {item.badge}
                      </span>
                    )}
                  </div>
                  {item.detail && (
                    <span className="block truncate font-mono text-xs text-muted-foreground/70">
                      {item.detail}
                    </span>
                  )}
                </div>
                {item.isSelected && <Check className="h-3 w-3 shrink-0 text-status-info" />}
              </button>
              {onCopy && (
                <button
                  type="button"
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover/item:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation();
                    onCopy(item.label);
                  }}
                  tabIndex={-1}
                >
                  <Copy className="h-3 w-3" />
                </button>
              )}
            </div>
          ))}
        </div>
        <div className="border-t border-border px-2 py-1.5">
          <input
            ref={searchInputRef}
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            placeholder={searchPlaceholder}
            aria-label={label}
            autoComplete="off"
            className="w-full bg-transparent text-sm placeholder:text-muted-foreground focus:outline-none"
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}

function BranchPicker({
  branches,
  selected,
  onChange,
}: {
  branches: string[];
  selected: string;
  onChange: (branch: string) => void;
}) {
  const { t } = useTranslation();

  const items: SearchablePickerItem[] = useMemo(
    () =>
      branches.map((b) => ({
        key: b,
        label: b,
        isSelected: b === selected,
      })),
    [branches, selected],
  );

  return (
    <SearchablePicker
      items={items}
      label={t('newThread.baseBranch', 'Base branch')}
      displayValue={selected || t('newThread.selectBranch')}
      searchPlaceholder={t('newThread.searchBranches', 'Search branches\u2026')}
      noMatchText={t('newThread.noBranchesMatch', 'No branches match')}
      onSelect={(branch) => onChange(branch)}
      onCopy={(branch) => {
        navigator.clipboard.writeText(branch);
        toast.success('Branch copied');
      }}
      triggerClassName="flex items-center gap-1 px-2 py-1 text-xs text-muted-foreground hover:text-foreground transition-colors rounded hover:bg-muted truncate max-w-[200px]"
      width="w-[30rem]"
    />
  );
}

interface PromptInputProps {
  onSubmit: (
    prompt: string,
    opts: {
      provider?: string;
      model: string;
      mode: string;
      threadMode?: string;
      baseBranch?: string;
      cwd?: string;
      sendToBacklog?: boolean;
      fileReferences?: { path: string }[];
    },
    images?: ImageAttachment[],
  ) => Promise<boolean | void> | boolean | void;
  onStop?: () => void;
  loading?: boolean;
  running?: boolean;
  queuedCount?: number;
  isQueueMode?: boolean;
  placeholder?: string;
  isNewThread?: boolean;
  showBacklog?: boolean;
  projectId?: string;
  initialPrompt?: string;
  initialImages?: ImageAttachment[];
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
  initialPrompt: initialPromptProp,
  initialImages: initialImagesProp,
}: PromptInputProps) {
  const { t } = useTranslation();

  // Resolve effective defaults from project settings (hardcoded fallbacks)
  const projectsForDefaults = useProjectStore((s) => s.projects);
  const selectedProjectIdForDefaults = useProjectStore((s) => s.selectedProjectId);
  const effectiveProject =
    propProjectId || selectedProjectIdForDefaults
      ? projectsForDefaults.find((p) => p.id === (propProjectId || selectedProjectIdForDefaults))
      : undefined;
  const defaultProvider = effectiveProject?.defaultProvider ?? 'claude';
  const defaultModel = effectiveProject?.defaultModel ?? 'sonnet';
  const defaultPermissionMode = effectiveProject?.defaultPermissionMode ?? 'autoEdit';
  const defaultThreadMode = effectiveProject?.defaultMode ?? 'worktree';

  const [prompt, setPrompt] = useState(initialPromptProp ?? '');
  const [unifiedModel, setUnifiedModel] = useState<string>(`${defaultProvider}:${defaultModel}`);
  const { provider, model } = useMemo(() => parseUnifiedModel(unifiedModel), [unifiedModel]);
  const [mode, setMode] = useState<string>(defaultPermissionMode);
  const [createWorktree, setCreateWorktree] = useState(defaultThreadMode === 'worktree');

  const unifiedModelGroups = useMemo(() => getUnifiedModelOptions(t), [t]);

  const modes = useMemo(
    () => [
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
  const contextUsage = useThreadStore((s) => s.activeThread?.contextUsage);
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
  const [mentionFiles, setMentionFiles] = useState<string[]>([]);
  const [mentionLoading, setMentionLoading] = useState(false);
  const [mentionTruncated, setMentionTruncated] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<string[]>([]);
  const mentionMenuRef = useRef<HTMLDivElement>(null);
  const mentionStartPosRef = useRef<number>(-1);
  const loadFilesTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const projects = useProjectStore((s) => s.projects);
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId);
  const selectedThreadId = useThreadStore((s) => s.selectedThreadId);

  // Draft persistence across thread switches
  const { setPromptDraft, clearPromptDraft } = useDraftStore();
  // Initialize to null so the mount effect always restores the draft for the current thread
  const prevThreadIdRef = useRef<string | null | undefined>(null);

  // Keep refs in sync so unmount cleanup can read the latest values
  const promptRef = useRef(prompt);
  const imagesRef = useRef(images);
  const selectedFilesRef = useRef(selectedFiles);
  const selectedThreadIdRef = useRef(selectedThreadId);
  promptRef.current = prompt;
  imagesRef.current = images;
  selectedFilesRef.current = selectedFiles;
  selectedThreadIdRef.current = selectedThreadId;

  // Save draft when switching away from a thread, restore when switching to a new one
  useEffect(() => {
    const prevId = prevThreadIdRef.current;
    prevThreadIdRef.current = selectedThreadId;

    // Save draft for the thread we're leaving
    if (prevId && prevId !== selectedThreadId) {
      const currentPrompt = textareaRef.current?.value ?? prompt;
      setPromptDraft(prevId, currentPrompt, images, selectedFiles);
    }

    // Restore draft for the thread we're entering
    if (selectedThreadId && selectedThreadId !== prevId) {
      const draft = useDraftStore.getState().drafts[selectedThreadId];
      setPrompt(draft?.prompt ?? '');
      setImages(draft?.images ?? []);
      setSelectedFiles(draft?.selectedFiles ?? []);
    } else if (!selectedThreadId) {
      setPrompt('');
      setImages([]);
      setSelectedFiles([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only save/restore drafts on thread switch; prompt/images/selectedFiles are read via refs to avoid re-runs on every keystroke
  }, [selectedThreadId]);

  // Save draft when the component unmounts (e.g. navigating to AllThreadsView)
  useEffect(() => {
    return () => {
      // Skip saving draft if the prompt was just submitted — the draft was
      // already cleared in handleSubmit and promptRef may still hold the
      // stale pre-submit value because React batches state updates.
      if (hasSubmittedRef.current) return;
      const threadId = selectedThreadIdRef.current;
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
  }, [selectedProjectId, selectedThreadId]);

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
  useEffect(() => {
    if (isNewThread && effectiveProjectId) {
      setNewThreadBranchesLoading(true);
      (async () => {
        const result = await api.listBranches(effectiveProjectId);
        if (result.isOk()) {
          const data = result.value;
          setNewThreadBranches(data.branches);
          if (data.defaultBranch) {
            setSelectedBranch(data.defaultBranch);
          } else if (data.branches.length > 0) {
            setSelectedBranch(data.branches[0]);
          }
        } else {
          setNewThreadBranches([]);
        }
        setNewThreadBranchesLoading(false);
      })();
    }
  }, [isNewThread, effectiveProjectId]);

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
          // Default to baseBranch (worktree source), then defaultBranch, then currentBranch
          if (activeThreadBaseBranch) {
            setFollowUpSelectedBranch(activeThreadBaseBranch);
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

  // Detect slash command trigger from prompt text
  useEffect(() => {
    // Show menu when prompt starts with / and has no spaces yet (typing command name)
    const match = prompt.match(/^\/(\S*)$/);
    if (match) {
      setSlashFilter(match[1]);
      setShowSlashMenu(true);
      setSlashIndex(0);
      loadSkills();
    } else {
      setShowSlashMenu(false);
    }
  }, [prompt, loadSkills]);

  // Scroll selected item into view
  useEffect(() => {
    if (!showSlashMenu || !slashMenuRef.current) return;
    const activeItem = slashMenuRef.current.children[slashIndex] as HTMLElement | undefined;
    activeItem?.scrollIntoView({ block: 'nearest' });
  }, [slashIndex, showSlashMenu]);

  const selectSkill = useCallback((skill: Skill) => {
    setPrompt(`/${skill.name} `);
    setShowSlashMenu(false);
    textareaRef.current?.focus();
  }, []);

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
          setMentionFiles(result.value.files);
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

  // Select a file from the mention menu (rerender-functional-setstate)
  const selectMentionFile = useCallback(
    (filePath: string) => {
      const startPos = mentionStartPosRef.current;
      setPrompt((prev) => {
        const before = prev.slice(0, startPos);
        const afterCursor = prev.slice(startPos + mentionFilter.length + 1); // +1 for @
        return `${before}@${filePath} ${afterCursor}`;
      });
      setSelectedFiles((prev) => (prev.includes(filePath) ? prev : [...prev, filePath]));
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

  // Focus when switching threads or when agent stops running
  useEffect(() => {
    textareaRef.current?.focus();
  }, [selectedThreadId]);

  useEffect(() => {
    if (!running) textareaRef.current?.focus();
  }, [running]);

  useEffect(() => {
    if (!loading) textareaRef.current?.focus();
  }, [loading]);

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

    // Capture current values and clear immediately for responsive UX
    const submittedPrompt = prompt;
    const submittedImages = images.length > 0 ? images : undefined;
    const submittedFiles =
      selectedFiles.length > 0 ? selectedFiles.map((p) => ({ path: p })) : undefined;
    setPrompt('');
    setImages([]);
    setSelectedFiles([]);
    hasSubmittedRef.current = true;
    if (selectedThreadId) clearPromptDraft(selectedThreadId);
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
    // Handle @ mention menu navigation
    if (showMentionMenu && mentionFiles.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMentionIndex((i) => (i + 1) % mentionFiles.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMentionIndex((i) => (i - 1 + mentionFiles.length) % mentionFiles.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        selectMentionFile(mentionFiles[mentionIndex]);
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

          // Add to selected files if not already added
          if (!selectedFiles.includes(filePath)) {
            setSelectedFiles((prev) => [...prev, filePath]);
            // Optionally add to prompt text as well
            setPrompt((prev) => (prev ? `${prev} @${filePath}` : `@${filePath}`));
          }
        }
      }
    }
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;

    for (const file of Array.from(files)) {
      await addImageFile(file);
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

        {/* Textarea + bottom toolbar */}
        <div
          className={cn(
            'relative rounded-md border bg-input/50',
            isDragging
              ? 'border-primary border-2 ring-2 ring-primary/20'
              : 'border-input focus-within:border-ring',
          )}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {/* File mention dropdown */}
          {showMentionMenu && (
            <div
              ref={mentionMenuRef}
              className="absolute bottom-full left-0 z-50 mb-1 max-h-52 w-full overflow-y-auto rounded-md border border-border bg-popover text-popover-foreground shadow-md"
            >
              {mentionLoading && mentionFiles.length === 0 ? (
                <div className="px-3 py-2 text-xs text-muted-foreground">
                  {t('prompt.loadingFiles', 'Loading files\u2026')}
                </div>
              ) : mentionFiles.length === 0 ? (
                <div className="px-3 py-2 text-xs text-muted-foreground">
                  {t('prompt.noFilesMatch', 'No files match')}
                </div>
              ) : (
                <>
                  {mentionFiles.map((file, i) => (
                    <button
                      key={file}
                      className={cn(
                        'w-full flex items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent transition-colors',
                        i === mentionIndex && 'bg-accent',
                        selectedFiles.includes(file) && 'text-primary',
                      )}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        selectMentionFile(file);
                      }}
                      onMouseEnter={() => setMentionIndex(i)}
                    >
                      <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate font-mono text-xs">{file}</span>
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
          <textarea
            ref={textareaCallbackRef}
            aria-label={t('prompt.messageLabel', 'Message')}
            className="w-full resize-none bg-transparent px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
            style={{ minHeight: '4.5rem' }}
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
              setPrompt(value);
              resizeTextarea();
              handleMentionDetection(value, e.target.selectionStart ?? value.length);
            }}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            rows={1}
            disabled={loading}
          />
          {/* Selected file mention chips */}
          {selectedFiles.length > 0 && (
            <div className="flex flex-wrap gap-1 border-t border-border/50 px-2 py-1">
              {selectedFiles.map((file) => (
                <span
                  key={file}
                  className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground"
                  title={file}
                >
                  <FileText className="h-3 w-3 shrink-0" />
                  {file.split('/').pop()}
                  <button
                    onClick={() => setSelectedFiles((prev) => prev.filter((f) => f !== file))}
                    aria-label={t('prompt.removeFile', 'Remove file')}
                    className="ml-0.5 hover:text-destructive"
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
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={handleFileSelect}
            disabled={loading || running}
          />
          {/* Bottom toolbar — single row */}
          <div className="px-2 py-2.5">
            <div className="no-scrollbar flex h-9 items-center gap-1 overflow-x-auto">
              <Button
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
              <Select value={mode} onValueChange={setMode}>
                <SelectTrigger
                  tabIndex={-1}
                  className="h-7 w-auto min-w-0 shrink-0 border-0 bg-transparent text-xs text-muted-foreground shadow-none hover:bg-accent hover:text-accent-foreground"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {modes.map((m) => (
                    <SelectItem key={m.value} value={m.value}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {/* Model + send — always visible, pushed right */}
              <div className="ml-auto flex shrink-0 items-center gap-1">
                <Select value={unifiedModel} onValueChange={setUnifiedModel}>
                  <SelectTrigger
                    tabIndex={-1}
                    className="h-7 w-auto min-w-0 shrink-0 border-0 bg-transparent text-xs text-muted-foreground shadow-none hover:bg-accent hover:text-accent-foreground"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {unifiedModelGroups.map((group) => (
                      <div key={group.provider}>
                        <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground">
                          {group.providerLabel}
                        </div>
                        {group.models.map((m) => (
                          <SelectItem key={m.value} value={m.value}>
                            {m.label}
                          </SelectItem>
                        ))}
                      </div>
                    ))}
                  </SelectContent>
                </Select>
                {contextUsage && contextUsage.cumulativeInputTokens > 0 && (() => {
                  const maxTokens = getContextWindow(activeThreadProvider ?? 'claude', activeThreadModel ?? 'sonnet');
                  const pct = Math.min(100, (contextUsage.cumulativeInputTokens / maxTokens) * 100);
                  const tokenK = Math.round(contextUsage.cumulativeInputTokens / 1000);
                  const colorClass = pct > 80 ? 'text-red-500' : pct > 60 ? 'text-amber-500' : 'text-muted-foreground';
                  return (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className={cn('cursor-default text-xs tabular-nums', colorClass)}>
                          {tokenK}K
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>
                        Context: {tokenK}K / {Math.round(maxTokens / 1000)}K tokens ({pct.toFixed(0)}%)
                      </TooltipContent>
                    </Tooltip>
                  );
                })()}
                {queuedCount > 0 && (
                  <span className="inline-flex items-center rounded bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground">
                    {queuedCount} {t('prompt.queued')}
                  </span>
                )}
                {running && !prompt.trim() ? (
                  <Button
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
                    checked={createWorktree}
                    onCheckedChange={setCreateWorktree}
                    tabIndex={-1}
                    className="h-4 w-7 data-[state=checked]:bg-primary data-[state=unchecked]:bg-input [&>span]:h-3 [&>span]:w-3 [&>span]:data-[state=checked]:translate-x-3"
                  />
                  <span>{t('thread.mode.worktree')}</span>
                </label>
                {showBacklog && (
                  <button
                    onClick={() => setSendToBacklog((v) => !v)}
                    tabIndex={-1}
                    className={cn(
                      'flex items-center gap-1 px-2 py-1 text-xs rounded transition-colors shrink-0 ml-auto',
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
              <div className="flex flex-col gap-1">
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
