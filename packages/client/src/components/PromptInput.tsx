import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Send, Square, Loader2, Image as ImageIcon, X, Zap, GitBranch, Check, Monitor } from 'lucide-react';
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
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { api } from '@/lib/api';
import { useAppStore } from '@/stores/app-store';
import { useSettingsStore } from '@/stores/settings-store';
import { ImageLightbox } from './ImageLightbox';
import type { ImageAttachment, Skill } from '@a-parallel/shared';

interface WorktreeInfo {
  path: string;
  branch: string;
  commit: string;
  isMain: boolean;
}

function WorktreePicker({
  projectId,
  currentPath,
  onChange,
}: {
  projectId: string;
  currentPath: string;
  onChange: (path: string) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [worktrees, setWorktrees] = useState<WorktreeInfo[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    api.listWorktrees(projectId)
      .then((data) => setWorktrees(data))
      .catch(() => setWorktrees([]))
      .finally(() => setLoading(false));
  }, [open, projectId]);

  const normalizedCurrent = currentPath.replace(/\\/g, '/').toLowerCase();
  const currentWorktree = worktrees.find(
    (wt) => wt.path.replace(/\\/g, '/').toLowerCase() === normalizedCurrent
  );
  const displayLabel = currentWorktree?.branch ?? currentPath.split(/[/\\]/).filter(Boolean).pop() ?? '...';

  const selectWorktree = (wt: WorktreeInfo) => {
    onChange(wt.path);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className="flex items-center gap-1 px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors rounded hover:bg-muted truncate max-w-[300px]"
          title={currentPath}
        >
          <GitBranch className="h-3 w-3 shrink-0" />
          <span className="truncate font-mono">{displayLabel}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        className="w-80 p-0 flex flex-col"
        style={{ maxHeight: '280px' }}
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <div className="px-3 py-2 border-b border-border bg-muted/30">
          <p className="text-[11px] font-medium text-muted-foreground">
            {t('prompt.selectWorktree', 'Select worktree')}
          </p>
        </div>

        <ScrollArea className="flex-1 min-h-0" style={{ maxHeight: '220px' }}>
          <div className="p-1">
            {loading && worktrees.length === 0 && (
              <p className="text-[11px] text-muted-foreground text-center py-3">
                {t('prompt.loadingWorktrees', 'Loading worktrees...')}
              </p>
            )}
            {!loading && worktrees.length === 0 && (
              <p className="text-[11px] text-muted-foreground text-center py-3">
                {t('prompt.noWorktrees', 'No worktrees available')}
              </p>
            )}
            {worktrees.map((wt) => {
              const isSelected = wt.path.replace(/\\/g, '/').toLowerCase() === normalizedCurrent;
              return (
                <button
                  key={wt.path}
                  onClick={() => selectWorktree(wt)}
                  className={cn(
                    'w-full flex items-center gap-2 rounded px-2 py-1.5 text-left text-[11px] transition-colors',
                    isSelected
                      ? 'bg-accent text-foreground'
                      : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                  )}
                >
                  <GitBranch className="h-3 w-3 shrink-0 text-blue-400" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="font-medium font-mono truncate">{wt.branch}</span>
                      {wt.isMain && (
                        <span className="text-[9px] px-1 py-0.5 rounded bg-muted text-muted-foreground leading-none">
                          main
                        </span>
                      )}
                    </div>
                    <span className="text-[10px] text-muted-foreground/70 truncate block font-mono">
                      {wt.commit?.slice(0, 8)}
                    </span>
                  </div>
                  {isSelected && <Check className="h-3 w-3 shrink-0 text-blue-400" />}
                </button>
              );
            })}
          </div>
        </ScrollArea>
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
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className="flex items-center gap-1 px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors rounded hover:bg-muted truncate max-w-[200px]"
        >
          <GitBranch className="h-3 w-3 shrink-0" />
          <span className="truncate font-mono">{selected || t('newThread.selectBranch')}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        className="w-64 p-0 flex flex-col"
        style={{ maxHeight: '280px' }}
      >
        <div className="px-3 py-2 border-b border-border bg-muted/30">
          <p className="text-[11px] font-medium text-muted-foreground">
            {t('newThread.baseBranch', 'Base branch')}
          </p>
        </div>
        <ScrollArea className="flex-1 min-h-0" style={{ maxHeight: '220px' }}>
          <div className="p-1">
            {branches.map((branch) => {
              const isSelected = branch === selected;
              return (
                <button
                  key={branch}
                  onClick={() => { onChange(branch); setOpen(false); }}
                  className={cn(
                    'w-full flex items-center gap-2 rounded px-2 py-1.5 text-left text-[11px] transition-colors',
                    isSelected
                      ? 'bg-accent text-foreground'
                      : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                  )}
                >
                  <GitBranch className="h-3 w-3 shrink-0 text-blue-400" />
                  <span className="font-medium font-mono truncate">{branch}</span>
                  {isSelected && <Check className="h-3 w-3 shrink-0 text-blue-400 ml-auto" />}
                </button>
              );
            })}
          </div>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}

interface PromptInputProps {
  onSubmit: (prompt: string, opts: { model: string; mode: string; threadMode?: string; baseBranch?: string; cwd?: string }, images?: ImageAttachment[]) => void;
  onStop?: () => void;
  loading?: boolean;
  running?: boolean;
  queuedCount?: number;
  placeholder?: string;
  isNewThread?: boolean;
  projectId?: string;
}

export function PromptInput({
  onSubmit,
  onStop,
  loading = false,
  running = false,
  placeholder,
  isNewThread = false,
  projectId: propProjectId,
}: PromptInputProps) {
  const { t } = useTranslation();

  const models = useMemo(() => [
    { value: 'haiku', label: t('thread.model.haiku') },
    { value: 'sonnet', label: t('thread.model.sonnet') },
    { value: 'opus', label: t('thread.model.opus') },
  ], [t]);

  const modes = useMemo(() => [
    { value: 'plan', label: t('prompt.plan') },
    { value: 'autoEdit', label: t('prompt.autoEdit') },
    { value: 'confirmEdit', label: t('prompt.askBeforeEdits') },
  ], [t]);

  const defaultThreadMode = useSettingsStore(s => s.defaultThreadMode);

  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState<string>('opus');
  const [mode, setMode] = useState<string>('autoEdit');
  const [threadMode, setThreadMode] = useState<string>(defaultThreadMode);
  const [newThreadBranches, setNewThreadBranches] = useState<string[]>([]);
  const [selectedBranch, setSelectedBranch] = useState<string>('');
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const textareaCallbackRef = useCallback((node: HTMLTextAreaElement | null) => {
    textareaRef.current = node;
    node?.focus();
  }, []);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState(0);

  // Slash-command state
  const [skills, setSkills] = useState<Skill[]>([]);
  const [skillsLoaded, setSkillsLoaded] = useState(false);
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const [slashFilter, setSlashFilter] = useState('');
  const [slashIndex, setSlashIndex] = useState(0);
  const slashMenuRef = useRef<HTMLDivElement>(null);
  const projects = useAppStore(s => s.projects);
  const selectedProjectId = useAppStore(s => s.selectedProjectId);
  const selectedThreadId = useAppStore(s => s.selectedThreadId);
  const activeThread = useAppStore(s => s.activeThread);

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

  // Fetch branches for new thread mode
  const effectiveProjectId = propProjectId || selectedProjectId;
  useEffect(() => {
    if (isNewThread && effectiveProjectId) {
      api.listBranches(effectiveProjectId).then((data) => {
        setNewThreadBranches(data.branches);
        if (data.defaultBranch) {
          setSelectedBranch(data.defaultBranch);
        } else if (data.branches.length > 0) {
          setSelectedBranch(data.branches[0]);
        }
      }).catch(() => setNewThreadBranches([]));
    }
  }, [isNewThread, effectiveProjectId]);

  // Fetch skills once when the menu first opens
  const loadSkills = useCallback(async () => {
    if (skillsLoaded) return;
    try {
      const projectPath = selectedProjectId
        ? projects.find((p) => p.id === selectedProjectId)?.path
        : undefined;
      const res = await api.listSkills(projectPath);
      // Deduplicate: if a skill exists at both global and project scope, keep only the project-level one
      const allSkills = res.skills ?? [];
      const deduped = new Map<string, Skill>();
      for (const skill of allSkills) {
        const existing = deduped.get(skill.name);
        if (!existing || skill.scope === 'project') {
          deduped.set(skill.name, skill);
        }
      }
      setSkills(Array.from(deduped.values()));
    } catch {
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

  // Focus when switching threads or when agent stops running
  useEffect(() => {
    textareaRef.current?.focus();
  }, [selectedThreadId]);

  useEffect(() => {
    if (!running) textareaRef.current?.focus();
  }, [running]);

  // Auto-resize textarea up to 35vh
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    const maxHeight = window.innerHeight * 0.35;
    ta.style.height = `${Math.min(ta.scrollHeight, maxHeight)}px`;
    ta.style.overflowY = ta.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, [prompt]);

  const handleSubmit = () => {
    if ((!prompt.trim() && images.length === 0) || loading) return;
    onSubmit(
      prompt,
      {
        model,
        mode,
        ...(isNewThread ? { threadMode, baseBranch: threadMode === 'worktree' ? selectedBranch : undefined } : {}),
        cwd: cwdOverride || undefined,
      },
      images.length > 0 ? images : undefined
    );
    setPrompt('');
    setImages([]);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
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
    <div className="pb-3 border-border md:flex md:justify-center">
      <div className="w-full md:w-1/2 md:min-w-[320px]">
        {/* Image previews */}
        {images.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-2">
            {images.map((img, idx) => (
              <div key={idx} className="relative group">
                <img
                  src={`data:${img.source.media_type};base64,${img.source.data}`}
                  alt={`Attachment ${idx + 1}`}
                  className="h-20 w-20 object-cover rounded border border-input cursor-pointer hover:opacity-80 transition-opacity"
                  onClick={() => { setLightboxIndex(idx); setLightboxOpen(true); }}
                />
                <button
                  onClick={() => removeImage(idx)}
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
        <div className="relative rounded-md border border-input bg-background focus-within:ring-1 focus-within:ring-ring transition-[border-color,box-shadow] duration-150">
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
            className="w-full px-3 py-2 text-sm bg-transparent placeholder:text-muted-foreground focus:outline-none resize-none"
            style={{ minHeight: '4.5rem' }}
            placeholder={running ? t('thread.agentWorkingQueue') : defaultPlaceholder}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            rows={1}
            disabled={loading}
          />
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
          {/* Mobile: two rows — Desktop: single row */}
          <div className="px-2 py-2 space-y-2 md:space-y-0">
            {/* Row 1 on mobile / only row on desktop: config + actions */}
            <div className="flex items-center gap-1 flex-wrap">
              {!isNewThread && effectiveCwd && selectedProjectId && (
                <WorktreePicker
                  projectId={selectedProjectId}
                  currentPath={effectiveCwd}
                  onChange={setCwdOverride}
                />
              )}
              {isNewThread && (
                <>
                  <div className="flex items-center gap-0.5 border border-border rounded-md overflow-hidden">
                    <button
                      onClick={() => setThreadMode('local')}
                      className={cn(
                        'px-2 py-1 text-[11px] flex items-center gap-1 transition-colors',
                        threadMode === 'local' ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground'
                      )}
                    >
                      <Monitor className="h-3 w-3" />
                      {t('thread.mode.local')}
                    </button>
                    <button
                      onClick={() => setThreadMode('worktree')}
                      className={cn(
                        'px-2 py-1 text-[11px] flex items-center gap-1 transition-colors',
                        threadMode === 'worktree' ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground'
                      )}
                    >
                      <GitBranch className="h-3 w-3" />
                      {t('thread.mode.worktree')}
                    </button>
                  </div>
                  {threadMode === 'worktree' && newThreadBranches.length > 0 && (
                    <BranchPicker
                      branches={newThreadBranches}
                      selected={selectedBranch}
                      onChange={setSelectedBranch}
                    />
                  )}
                </>
              )}
              <Select value={model} onValueChange={setModel}>
                <SelectTrigger className="h-7 w-[100px] text-xs">
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
                <SelectTrigger className="h-7 w-[140px] text-xs">
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
              {/* On desktop: image + send stay in this row */}
              <div className="hidden md:flex items-center gap-1 ml-auto">
                <Button
                  onClick={() => fileInputRef.current?.click()}
                  variant="ghost"
                  size="icon-sm"
                  title={t('prompt.addImage')}
                  disabled={loading || running}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <ImageIcon className="h-4 w-4" />
                </Button>
                {running ? (
                  <Button
                    onClick={onStop}
                    variant="destructive"
                    size="icon-sm"
                    title={t('prompt.stopAgent')}
                  >
                    <Square className="h-3.5 w-3.5" />
                  </Button>
                ) : (
                  <Button
                    onClick={handleSubmit}
                    disabled={(!prompt.trim() && images.length === 0) || loading}
                    size="icon-sm"
                  >
                    {loading ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Send className="h-3.5 w-3.5" />
                    )}
                  </Button>
                )}
              </div>
            </div>
            {/* Row 2 on mobile only: image + send */}
            <div className="flex items-center gap-1.5 md:hidden">
              <div className="flex-1" />
              <Button
                onClick={() => fileInputRef.current?.click()}
                variant="ghost"
                size="icon-sm"
                title={t('prompt.addImage')}
                disabled={loading || running}
                className="text-muted-foreground hover:text-foreground shrink-0"
              >
                <ImageIcon className="h-4 w-4" />
              </Button>
              {running ? (
                <Button
                  onClick={onStop}
                  variant="destructive"
                  size="icon-sm"
                  title={t('prompt.stopAgent')}
                  className="shrink-0"
                >
                  <Square className="h-3.5 w-3.5" />
                </Button>
              ) : (
                <Button
                  onClick={handleSubmit}
                  disabled={(!prompt.trim() && images.length === 0) || loading}
                  size="icon-sm"
                  className="shrink-0"
                >
                  {loading ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Send className="h-3.5 w-3.5" />
                  )}
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
