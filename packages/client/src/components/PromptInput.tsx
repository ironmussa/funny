import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ArrowUp, Square, Loader2, Paperclip, X, Zap, GitBranch, Check, Inbox, FileText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { api } from '@/lib/api';
import { PROVIDERS, getModelOptions } from '@/lib/providers';
import { useThreadStore } from '@/stores/thread-store';
import { useProjectStore } from '@/stores/project-store';
import { useDraftStore } from '@/stores/draft-store';
import { ImageLightbox } from './ImageLightbox';
import type { ImageAttachment, Skill } from '@funny/shared';

interface WorktreeInfo {
  path: string;
  branch: string;
  commit: string;
  isMain: boolean;
}

interface SearchablePickerItem {
  key: string;
  label: string;
  isSelected: boolean;
  detail?: string;
  badge?: string;
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
  triggerClassName,
  triggerTitle,
  width = 'w-72',
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
    <Popover open={open} onOpenChange={(v) => { setOpen(v); if (!v) { setSearch(''); setHighlightIndex(-1); } }}>
      <PopoverTrigger asChild>
        <button
          className={triggerClassName ?? 'flex items-center gap-1 px-2 py-1 text-xs text-muted-foreground hover:text-foreground transition-colors rounded hover:bg-muted truncate max-w-[300px]'}
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
        onOpenAutoFocus={(e) => { e.preventDefault(); searchInputRef.current?.focus(); }}
      >
        <div className="px-3 py-2 border-b border-border bg-muted/30">
          <p className="text-sm font-medium text-muted-foreground">{label}</p>
        </div>
        <div className="px-2 py-1.5 border-b border-border">
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
        <div
          className="flex-1 min-h-0 overflow-y-auto overscroll-contain p-1"
          ref={listRef}
          style={{ maxHeight: 'min(60vh, 440px)' }}
        >
          {loading && items.length === 0 && loadingText && (
            <p className="text-sm text-muted-foreground text-center py-3">{loadingText}</p>
          )}
          {!loading && items.length === 0 && emptyText && (
            <p className="text-sm text-muted-foreground text-center py-3">{emptyText}</p>
          )}
          {!loading && items.length > 0 && filtered.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-3">{noMatchText}</p>
          )}
          {filtered.map((item, i) => (
            <button
              key={item.key}
              ref={(el) => { itemRefs.current[i] = el; }}
              onClick={() => { onSelect(item.key); setOpen(false); setSearch(''); }}
              onKeyDown={(e) => handleItemKeyDown(e, i)}
              onFocus={() => setHighlightIndex(i)}
              onMouseEnter={() => { setHighlightIndex(i); itemRefs.current[i]?.focus(); }}
              className={cn(
                'w-full flex items-center gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors outline-none',
                i === highlightIndex
                  ? 'bg-accent text-foreground'
                  : item.isSelected
                    ? 'bg-accent/50 text-foreground'
                    : 'text-muted-foreground hover:bg-accent hover:text-foreground'
              )}
            >
              <GitBranch className="h-3 w-3 shrink-0 text-status-info" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="font-medium font-mono truncate">{item.label}</span>
                  {item.badge && (
                    <span className="text-[9px] px-1 py-0.5 rounded bg-muted text-muted-foreground leading-none">
                      {item.badge}
                    </span>
                  )}
                </div>
                {item.detail && (
                  <span className="text-xs text-muted-foreground/70 truncate block font-mono">
                    {item.detail}
                  </span>
                  )}
              </div>
              {item.isSelected && <Check className="h-3 w-3 shrink-0 text-status-info" />}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function WorktreePicker({
  projectId,
  currentPath,
  threadBranch,
  onChange,
}: {
  projectId: string;
  currentPath: string;
  threadBranch?: string;
  onChange: (path: string) => void;
}) {
  const { t } = useTranslation();
  const [worktrees, setWorktrees] = useState<WorktreeInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [fetchTrigger, setFetchTrigger] = useState(0);

  // Load worktrees on mount so the branch label is available immediately
  useEffect(() => {
    (async () => {
      const result = await api.listWorktrees(projectId);
      if (result.isOk()) setWorktrees(result.value);
      else setWorktrees([]);
    })();
  }, [projectId]);

  // Refresh worktrees when user interacts with the picker
  useEffect(() => {
    if (!fetchTrigger) return;
    setLoading(true);
    (async () => {
      const result = await api.listWorktrees(projectId);
      if (result.isOk()) setWorktrees(result.value);
      else setWorktrees([]);
      setLoading(false);
    })();
  }, [fetchTrigger, projectId]);

  const normalizedCurrent = currentPath.replace(/\\/g, '/').toLowerCase();
  const currentWorktree = worktrees.find(
    (wt) => wt.path.replace(/\\/g, '/').toLowerCase() === normalizedCurrent
  );
  const displayLabel = currentWorktree?.branch ?? threadBranch ?? '\u2026';

  const items: SearchablePickerItem[] = useMemo(() => worktrees.map((wt) => ({
    key: wt.path,
    label: wt.branch,
    isSelected: wt.path.replace(/\\/g, '/').toLowerCase() === normalizedCurrent,
    detail: wt.commit?.slice(0, 8),
    badge: wt.isMain ? 'main' : undefined,
  })), [worktrees, normalizedCurrent]);

  return (
    <div onMouseDown={() => setFetchTrigger((n) => n + 1)}>
      <SearchablePicker
        items={items}
        label={t('prompt.selectWorktree', 'Select worktree')}
        displayValue={displayLabel}
        searchPlaceholder={t('prompt.searchWorktrees', 'Search worktrees\u2026')}
        noMatchText={t('prompt.noWorktreesMatch', 'No worktrees match')}
        emptyText={t('prompt.noWorktrees', 'No worktrees available')}
        loadingText={t('prompt.loadingWorktrees', 'Loading worktrees\u2026')}
        loading={loading}
        onSelect={(path) => onChange(path)}
        triggerTitle={currentPath}
        width="w-80"
      />
    </div>
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

  const items: SearchablePickerItem[] = useMemo(() => branches.map((b) => ({
    key: b,
    label: b,
    isSelected: b === selected,
  })), [branches, selected]);

  return (
    <SearchablePicker
      items={items}
      label={t('newThread.baseBranch', 'Base branch')}
      displayValue={selected || t('newThread.selectBranch')}
      searchPlaceholder={t('newThread.searchBranches', 'Search branches\u2026')}
      noMatchText={t('newThread.noBranchesMatch', 'No branches match')}
      onSelect={(branch) => onChange(branch)}
      triggerClassName="flex items-center gap-1 px-2 py-1 text-xs text-muted-foreground hover:text-foreground transition-colors rounded hover:bg-muted truncate max-w-[200px]"
      width="w-64"
    />
  );
}

interface PromptInputProps {
  onSubmit: (prompt: string, opts: { provider?: string; model: string; mode: string; threadMode?: string; baseBranch?: string; cwd?: string; sendToBacklog?: boolean; fileReferences?: { path: string }[] }, images?: ImageAttachment[]) => Promise<boolean | void> | boolean | void;
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
}

export function PromptInput({
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
}: PromptInputProps) {
  const { t } = useTranslation();

  // Resolve effective defaults from project settings (hardcoded fallbacks)
  const projectsForDefaults = useProjectStore(s => s.projects);
  const selectedProjectIdForDefaults = useProjectStore(s => s.selectedProjectId);
  const effectiveProject = (propProjectId || selectedProjectIdForDefaults)
    ? projectsForDefaults.find(p => p.id === (propProjectId || selectedProjectIdForDefaults))
    : undefined;
  const defaultProvider = effectiveProject?.defaultProvider ?? 'claude';
  const defaultModel = effectiveProject?.defaultModel ?? 'sonnet';
  const defaultPermissionMode = effectiveProject?.defaultPermissionMode ?? 'autoEdit';
  const defaultThreadMode = effectiveProject?.defaultMode ?? 'worktree';

  const [prompt, setPrompt] = useState(initialPromptProp ?? '');
  const [provider, setProvider] = useState<string>(defaultProvider);
  const [model, setModel] = useState<string>(defaultModel);
  const [mode, setMode] = useState<string>(defaultPermissionMode);
  const [createWorktree, setCreateWorktree] = useState(defaultThreadMode === 'worktree');

  const models = useMemo(() => getModelOptions(provider, t), [provider, t]);

  const modes = useMemo(() => [
    { value: 'plan', label: t('prompt.plan') },
    { value: 'autoEdit', label: t('prompt.autoEdit') },
    { value: 'confirmEdit', label: t('prompt.askBeforeEdits') },
  ], [t]);

  // Sync mode with active thread's permission mode
  const activeThread = useThreadStore(s => s.activeThread);
  const activeThreadPermissionMode = activeThread?.permissionMode;
  const [newThreadBranches, setNewThreadBranches] = useState<string[]>([]);
  const [selectedBranch, setSelectedBranch] = useState<string>('');
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [sendToBacklog, setSendToBacklog] = useState(false);
  const [localCurrentBranch, setLocalCurrentBranch] = useState<string | null>(null);
  // For existing threads in local mode: allow creating a worktree
  const [createWorktreeForFollowUp, setCreateWorktreeForFollowUp] = useState(false);
  const [followUpBranches, setFollowUpBranches] = useState<string[]>([]);
  const [followUpSelectedBranch, setFollowUpSelectedBranch] = useState<string>('');


  // When provider changes, reset model to first available for that provider
  useEffect(() => {
    if (!models.some(m => m.value === model)) {
      setModel(models[0].value);
    }
  }, [provider]);
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

  // Load initial prompt when prop changes (e.g. navigating to a backlog thread)
  useEffect(() => {
    if (initialPromptProp) setPrompt(initialPromptProp);
  }, [initialPromptProp]);

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

  const projects = useProjectStore(s => s.projects);
  const selectedProjectId = useProjectStore(s => s.selectedProjectId);
  const selectedThreadId = useThreadStore(s => s.selectedThreadId);

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
  }, []);

  // Derive project path and manage cwd override
  const projectPath = useMemo(
    () => selectedProjectId ? projects.find((p) => p.id === selectedProjectId)?.path ?? '' : '',
    [selectedProjectId, projects]
  );
  const [cwdOverride, setCwdOverride] = useState<string | null>(null);
  const threadCwd = activeThread?.worktreePath || projectPath;
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

  // Sync provider with active thread's provider when thread changes
  useEffect(() => {
    if (!isNewThread && activeThread?.provider) {
      setProvider(activeThread.provider);
    } else if (isNewThread) {
      setProvider(defaultProvider);
    }
  }, [isNewThread, activeThread?.provider, defaultProvider]);

  // Sync model with active thread's model when thread changes
  useEffect(() => {
    if (!isNewThread && activeThread?.model) {
      setModel(activeThread.model);
    } else if (isNewThread) {
      setModel(defaultModel);
    }
  }, [isNewThread, activeThread?.model, defaultModel]);

  // Fetch branches for new thread mode
  const effectiveProjectId = propProjectId || selectedProjectId;
  useEffect(() => {
    if (isNewThread && effectiveProjectId) {
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
      })();
    }
  }, [isNewThread, effectiveProjectId]);

  // Fetch current branch for local mode threads without a saved branch
  useEffect(() => {
    if (!isNewThread && activeThread?.mode === 'local' && !activeThread?.branch && selectedProjectId) {
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
  }, [isNewThread, activeThread?.mode, activeThread?.branch, selectedProjectId]);

  // Fetch branches for follow-up worktree creation (when in local mode thread)
  useEffect(() => {
    if (!isNewThread && activeThread?.mode === 'local' && selectedProjectId) {
      (async () => {
        const result = await api.listBranches(selectedProjectId);
        if (result.isOk()) {
          const data = result.value;
          setFollowUpBranches(data.branches);
          if (data.defaultBranch) {
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
  }, [isNewThread, activeThread?.mode, selectedProjectId]);

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
    s.name.toLowerCase().includes(slashFilter.toLowerCase())
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
  const loadFiles = useCallback((query: string) => {
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
  }, [cwdOverride, threadCwd]);

  // Handle @ mention trigger detection
  const handleMentionDetection = useCallback((value: string, cursorPos: number) => {
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
  }, [loadFiles]);

  // Select a file from the mention menu (rerender-functional-setstate)
  const selectMentionFile = useCallback((filePath: string) => {
    const startPos = mentionStartPosRef.current;
    setPrompt(prev => {
      const before = prev.slice(0, startPos);
      const afterCursor = prev.slice(startPos + mentionFilter.length + 1); // +1 for @
      return `${before}@${filePath} ${afterCursor}`;
    });
    setSelectedFiles(prev => prev.includes(filePath) ? prev : [...prev, filePath]);
    setShowMentionMenu(false);
    textareaRef.current?.focus();
  }, [mentionFilter]);

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

  // Auto-resize textarea up to 35vh (called imperatively to avoid re-render dependency on prompt)
  const resizeTextarea = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    const maxHeight = window.innerHeight * 0.35;
    ta.style.height = `${Math.min(ta.scrollHeight, maxHeight)}px`;
    ta.style.overflowY = ta.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, []);

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
    const submittedFiles = selectedFiles.length > 0 ? selectedFiles.map(p => ({ path: p })) : undefined;
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
          ? { threadMode: createWorktree ? 'worktree' : 'local', baseBranch: selectedBranch || undefined, sendToBacklog }
          : createWorktreeForFollowUp
            ? { threadMode: 'worktree', baseBranch: followUpSelectedBranch || undefined }
            : {}
        ),
        cwd: cwdOverride || undefined,
        fileReferences: submittedFiles,
      },
      submittedImages
    );
    if (result === false) {
      // Restore on failure
      hasSubmittedRef.current = false;
      setPrompt(submittedPrompt);
      setImages(submittedImages ?? []);
      setSelectedFiles(submittedFiles?.map(f => f.path) ?? []);
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

    if (loading || running) return;

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
            setSelectedFiles(prev => [...prev, filePath]);
            // Optionally add to prompt text as well
            setPrompt(prev => prev ? `${prev} @${filePath}` : `@${filePath}`);
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

        setImages(prev => [...prev, {
          type: 'image',
          source: {
            type: 'base64',
            media_type: mediaType,
            data: base64,
          },
        }]);
        resolve();
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  };

  const removeImage = (index: number) => {
    setImages(prev => prev.filter((_, i) => i !== index));
  };

  const defaultPlaceholder = placeholder ?? t('thread.describeTaskDefault');

  return (
    <div className="py-3 border-border px-4">
      <div className="w-full mx-auto max-w-3xl min-w-0">
        {/* Image previews */}
        {images.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-2">
            {images.map((img, idx) => (
              <div key={idx} className="relative group">
                <img
                  src={`data:${img.source.media_type};base64,${img.source.data}`}
                  alt={`Attachment ${idx + 1}`}
                  width={80}
                  height={80}
                  className="h-20 w-20 object-cover rounded border border-input cursor-pointer hover:opacity-80 transition-opacity"
                  onClick={() => { setLightboxIndex(idx); setLightboxOpen(true); }}
                />
                <button
                  onClick={() => removeImage(idx)}
                  aria-label={t('prompt.removeImage', 'Remove image')}
                  className="absolute -top-1 -right-1 bg-destructive text-destructive-foreground rounded-full p-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
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
            "relative rounded-md border bg-background",
            isDragging
              ? "border-primary border-2 ring-2 ring-primary/20"
              : "border-input focus-within:ring-1 focus-within:ring-ring"
          )}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {/* File mention dropdown */}
          {showMentionMenu && (
            <div
              ref={mentionMenuRef}
              className="absolute bottom-full left-0 mb-1 w-full max-h-52 overflow-y-auto rounded-md border border-border bg-popover text-popover-foreground shadow-md z-50"
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
                        selectedFiles.includes(file) && 'text-primary'
                      )}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        selectMentionFile(file);
                      }}
                      onMouseEnter={() => setMentionIndex(i)}
                    >
                      <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span className="font-mono text-xs truncate">{file}</span>
                    </button>
                  ))}
                  {mentionTruncated && (
                    <div className="px-3 py-1.5 text-xs text-muted-foreground border-t border-border">
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
              className="absolute bottom-full left-0 mb-1 w-full max-h-52 overflow-y-auto rounded-md border border-border bg-popover text-popover-foreground shadow-md z-50"
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
                      i === slashIndex && 'bg-accent'
                    )}
                    onMouseDown={(e) => {
                      e.preventDefault(); // prevent textarea blur
                      selectSkill(skill);
                    }}
                    onMouseEnter={() => setSlashIndex(i)}
                  >
                    <Zap className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
                    <div className="min-w-0">
                      <div className="font-medium font-mono text-xs">/{skill.name}</div>
                      {skill.description && (
                        <div className="text-xs text-muted-foreground truncate">{skill.description}</div>
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
            className="w-full px-3 py-2 text-sm bg-transparent placeholder:text-muted-foreground focus:outline-none resize-none"
            style={{ minHeight: '4.5rem' }}
            placeholder={running ? (isQueueMode ? t('thread.typeToQueue') : t('thread.agentWorkingQueue')) : defaultPlaceholder}
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
            <div className="px-2 py-1 flex flex-wrap gap-1 border-t border-border/50">
              {selectedFiles.map((file) => (
                <span
                  key={file}
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 text-xs font-mono bg-muted rounded text-muted-foreground"
                  title={file}
                >
                  <FileText className="h-3 w-3 shrink-0" />
                  {file.split('/').pop()}
                  <button
                    onClick={() => setSelectedFiles(prev => prev.filter(f => f !== file))}
                    aria-label={t('prompt.removeFile', 'Remove file')}
                    className="hover:text-destructive ml-0.5"
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
          {/* Bottom toolbar — single row, horizontal scroll to avoid layout shifts from wrapping */}
          <div className="px-2 py-2.5">
            <div className="flex items-center gap-1 overflow-x-auto no-scrollbar h-9">
              {!isNewThread && effectiveCwd && selectedProjectId && (
                activeThread?.mode === 'worktree' ? (
                  <WorktreePicker
                    projectId={selectedProjectId}
                    currentPath={effectiveCwd}
                    threadBranch={activeThread?.branch}
                    onChange={setCwdOverride}
                  />
                ) : activeThread?.mode === 'local' ? (
                  <>
                    {!createWorktreeForFollowUp && (activeThread?.branch || localCurrentBranch) && (
                      <button className="flex items-center gap-1 px-2 py-1 text-xs text-muted-foreground hover:text-foreground transition-colors rounded hover:bg-muted truncate max-w-[300px]" disabled>
                        <GitBranch className="h-3 w-3 shrink-0" />
                        <span className="truncate font-mono">{activeThread?.branch || localCurrentBranch}</span>
                      </button>
                    )}
                    {createWorktreeForFollowUp && followUpBranches.length > 0 && (
                      <BranchPicker
                        branches={followUpBranches}
                        selected={followUpSelectedBranch}
                        onChange={setFollowUpSelectedBranch}
                      />
                    )}
                    <button
                      onClick={() => setCreateWorktreeForFollowUp(!createWorktreeForFollowUp)}
                      tabIndex={-1}
                      className={cn(
                        'flex items-center gap-1 px-2 py-1 text-xs rounded transition-colors shrink-0',
                        createWorktreeForFollowUp
                          ? 'bg-primary/10 text-primary'
                          : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                      )}
                      title={t('newThread.createWorktree', 'Create isolated worktree')}
                    >
                      <GitBranch className="h-3 w-3" />
                      <span>{t('thread.mode.worktree')}</span>
                    </button>
                  </>
                ) : null
              )}
              {isNewThread && newThreadBranches.length > 0 && (
                <BranchPicker
                  branches={newThreadBranches}
                  selected={selectedBranch}
                  onChange={setSelectedBranch}
                />
              )}
              {isNewThread && (
                <button
                  onClick={() => setCreateWorktree(!createWorktree)}
                  tabIndex={-1}
                  className={cn(
                    'flex items-center gap-1 px-2 py-1 text-xs rounded transition-colors shrink-0',
                    createWorktree
                      ? 'bg-primary/10 text-primary'
                      : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                  )}
                  title={t('newThread.createWorktree', 'Create isolated worktree')}
                >
                  <span>{t('thread.mode.worktree')}</span>
                </button>
              )}
              <Select value={provider} onValueChange={setProvider}>
                <SelectTrigger tabIndex={-1} className="h-7 w-auto min-w-0 text-xs border-0 bg-transparent shadow-none text-muted-foreground hover:bg-accent hover:text-accent-foreground shrink-0">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PROVIDERS.map((p) => (
                    <SelectItem key={p.value} value={p.value}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={model} onValueChange={setModel}>
                <SelectTrigger tabIndex={-1} className="h-7 w-auto min-w-0 text-xs border-0 bg-transparent shadow-none text-muted-foreground hover:bg-accent hover:text-accent-foreground shrink-0">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {models.map((m) => (
                    <SelectItem key={m.value} value={m.value}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={mode} onValueChange={setMode}>
                <SelectTrigger tabIndex={-1} className="h-7 w-auto min-w-0 text-xs border-0 bg-transparent shadow-none text-muted-foreground hover:bg-accent hover:text-accent-foreground shrink-0">
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
              {showBacklog && (
                <button
                  onClick={() => setSendToBacklog((v) => !v)}
                  tabIndex={-1}
                  className={cn(
                    'flex items-center gap-1 px-2 py-1 text-xs rounded transition-colors shrink-0',
                    sendToBacklog
                      ? 'bg-primary/10 text-primary'
                      : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                  )}
                  title={t('prompt.sendToBacklog')}
                >
                  <Inbox className="h-3 w-3" />
                  {t('prompt.backlog')}
                </button>
              )}
              {/* Attach + send — always visible, pushed right */}
              <div className="flex items-center gap-1 ml-auto shrink-0">
                <Button
                  onClick={() => fileInputRef.current?.click()}
                  variant="ghost"
                  size="icon-sm"
                  tabIndex={-1}
                  aria-label={t('prompt.attach')}
                  disabled={loading || (running && !isQueueMode)}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <Paperclip className="h-4 w-4" />
                </Button>
                {queuedCount > 0 && (
                  <span className="inline-flex items-center px-1.5 py-0.5 text-xs font-medium rounded bg-muted text-muted-foreground">
                    {queuedCount} {t('prompt.queued')}
                  </span>
                )}
                {running && !isQueueMode ? (
                  <Button
                    onClick={onStop}
                    variant="destructive"
                    size="icon-sm"
                    tabIndex={-1}
                    aria-label={t('prompt.stopAgent')}
                  >
                    <Square className="h-3.5 w-3.5" />
                  </Button>
                ) : running && isQueueMode ? (
                  <>
                    <Button
                      onClick={handleSubmit}
                      disabled={loading}
                      size="icon-sm"
                      tabIndex={-1}
                      aria-label={t('prompt.queueMessage')}
                    >
                      {loading ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <ArrowUp className="h-3.5 w-3.5" />
                      )}
                    </Button>
                    <Button
                      onClick={onStop}
                      variant="destructive"
                      size="icon-sm"
                      tabIndex={-1}
                      aria-label={t('prompt.stopAgent')}
                    >
                      <Square className="h-3.5 w-3.5" />
                    </Button>
                  </>
                ) : (
                  <Button
                    onClick={handleSubmit}
                    disabled={loading}
                    size="icon-sm"
                    tabIndex={-1}
                    aria-label={t('prompt.send', 'Send message')}
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
        </div>
      </div>
    </div>
  );
}
