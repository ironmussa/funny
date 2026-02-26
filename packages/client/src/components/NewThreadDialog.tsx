import { GitBranch, Check, ChevronsUpDown, Search } from 'lucide-react';
import { useState, useEffect, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { api } from '@/lib/api';
import { PROVIDERS, getModelOptions } from '@/lib/providers';
import { cn } from '@/lib/utils';
import { useProjectStore } from '@/stores/project-store';
import { useThreadStore } from '@/stores/thread-store';
import { useUIStore } from '@/stores/ui-store';

export function NewThreadDialog() {
  const { t } = useTranslation();
  const newThreadProjectId = useUIStore((s) => s.newThreadProjectId);
  const cancelNewThread = useUIStore((s) => s.cancelNewThread);
  const setReviewPaneOpen = useUIStore((s) => s.setReviewPaneOpen);
  const loadThreadsForProject = useThreadStore((s) => s.loadThreadsForProject);
  const selectThread = useThreadStore((s) => s.selectThread);

  const projects = useProjectStore((s) => s.projects);
  const project = newThreadProjectId
    ? projects.find((p) => p.id === newThreadProjectId)
    : undefined;
  const defaultThreadMode = project?.defaultMode ?? 'worktree';
  const defaultProvider = project?.defaultProvider ?? 'claude';
  const defaultModel = project?.defaultModel ?? 'sonnet';
  const [createWorktree, setCreateWorktree] = useState(defaultThreadMode === 'worktree');
  const [provider, setProvider] = useState<string>(defaultProvider);
  const [model, setModel] = useState<string>(defaultModel);
  const models = useMemo(() => getModelOptions(provider, t), [provider, t]);
  const [branches, setBranches] = useState<string[]>([]);
  const [selectedBranch, setSelectedBranch] = useState('');
  const [prompt, setPrompt] = useState('');
  const [title, setTitle] = useState('');
  const [creating, setCreating] = useState(false);
  const [branchSearch, setBranchSearch] = useState('');
  const [branchOpen, setBranchOpen] = useState(false);
  const branchSearchRef = useRef<HTMLInputElement>(null);

  // Reset model when provider changes and current model isn't valid for new provider
  useEffect(() => {
    if (!models.some((m) => m.value === model)) {
      setModel(models[0].value);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally only runs when provider changes to reset model; models is derived from provider
  }, [provider]);

  // Load branches and detect default branch when dialog opens
  useEffect(() => {
    if (newThreadProjectId) {
      api.listBranches(newThreadProjectId).then((result) => {
        if (result.isOk()) {
          const data = result.value;
          setBranches(data.branches);
          if (data.defaultBranch) {
            setSelectedBranch(data.defaultBranch);
          } else if (data.branches.length > 0) {
            setSelectedBranch(data.branches[0]);
          }
        } else {
          console.error(result.error);
        }
      });
    }
  }, [newThreadProjectId]);

  const handleCreate = async () => {
    if (!prompt || !newThreadProjectId || creating) return;
    setCreating(true);

    const result = await api.createThread({
      projectId: newThreadProjectId,
      title: title || prompt,
      mode: createWorktree ? 'worktree' : 'local',
      model,
      provider,
      baseBranch: selectedBranch || undefined,
      prompt,
    });

    if (result.isErr()) {
      toast.error(result.error.message);
      setCreating(false);
      return;
    }

    await loadThreadsForProject(newThreadProjectId);
    await selectThread(result.value.id);
    setReviewPaneOpen(false);
    cancelNewThread();
    setCreating(false);
  };

  return (
    <Dialog open onOpenChange={(open) => !open && cancelNewThread()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('newThread.title')}</DialogTitle>
        </DialogHeader>

        {/* Branch selector */}
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">
            {t('newThread.branch', 'Branch')}
          </label>
          <Popover
            open={branchOpen}
            onOpenChange={(v) => {
              setBranchOpen(v);
              if (!v) setBranchSearch('');
            }}
          >
            <PopoverTrigger asChild>
              <button className="flex h-9 w-full items-center justify-between rounded-md border border-input bg-background px-3 text-sm transition-[border-color,box-shadow] duration-150 hover:bg-accent/50 focus:outline-none focus:ring-1 focus:ring-ring">
                <div className="flex min-w-0 items-center gap-2">
                  <GitBranch className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{selectedBranch || t('newThread.selectBranch')}</span>
                </div>
                <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              </button>
            </PopoverTrigger>
            <PopoverContent
              className="flex w-[var(--radix-popover-trigger-width)] flex-col overflow-hidden p-0"
              style={{ maxHeight: '320px' }}
              align="start"
              onOpenAutoFocus={(e) => {
                e.preventDefault();
                branchSearchRef.current?.focus();
              }}
            >
              <div className="flex items-center gap-2 border-b border-border px-3 py-2">
                <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <input
                  ref={branchSearchRef}
                  type="text"
                  value={branchSearch}
                  onChange={(e) => setBranchSearch(e.target.value)}
                  placeholder={t('newThread.searchBranches', 'Search branches…')}
                  aria-label={t('newThread.searchBranches', 'Search branches')}
                  autoComplete="off"
                  className="w-full bg-transparent text-sm placeholder:text-muted-foreground focus:outline-none"
                />
              </div>
              <ScrollArea className="min-h-0 flex-1" style={{ maxHeight: '260px' }} type="always">
                <div className="p-1">
                  {branches
                    .filter(
                      (b) => !branchSearch || b.toLowerCase().includes(branchSearch.toLowerCase()),
                    )
                    .map((b) => {
                      const isSelected = b === selectedBranch;
                      return (
                        <button
                          key={b}
                          onClick={() => {
                            setSelectedBranch(b);
                            setBranchOpen(false);
                            setBranchSearch('');
                          }}
                          className={cn(
                            'w-full flex items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors',
                            isSelected
                              ? 'bg-accent text-foreground'
                              : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                          )}
                        >
                          <GitBranch className="h-3.5 w-3.5 shrink-0 text-status-info" />
                          <span className="truncate font-mono">{b}</span>
                          {isSelected && (
                            <Check className="ml-auto h-3.5 w-3.5 shrink-0 text-status-info" />
                          )}
                        </button>
                      );
                    })}
                  {branches.filter(
                    (b) => !branchSearch || b.toLowerCase().includes(branchSearch.toLowerCase()),
                  ).length === 0 && (
                    <p className="py-3 text-center text-sm text-muted-foreground">
                      {t('newThread.noBranchesMatch', 'No branches match')}
                    </p>
                  )}
                </div>
              </ScrollArea>
            </PopoverContent>
          </Popover>
        </div>

        {/* Worktree toggle */}
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={createWorktree}
            onChange={(e) => setCreateWorktree(e.target.checked)}
            className="h-4 w-4 rounded border-input text-primary focus:ring-1 focus:ring-ring"
          />
          <div className="flex items-center gap-2 text-sm">
            <GitBranch className="h-3.5 w-3.5 text-muted-foreground" />
            <span>{t('newThread.createWorktree', 'Create isolated worktree')}</span>
          </div>
        </label>

        {/* Provider + Model selector */}
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">
            {t('newThread.model')}
          </label>
          <div className="flex gap-2">
            <Select value={provider} onValueChange={setProvider}>
              <SelectTrigger className="w-[120px]">
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
              <SelectTrigger className="flex-1">
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
          </div>
        </div>

        {/* Title */}
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">
            {t('newThread.titleOptional')}
          </label>
          <Input
            placeholder={t('newThread.autoFromPrompt')}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>

        {/* Prompt */}
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">
            {t('newThread.prompt')}
          </label>
          <textarea
            className="min-h-[120px] w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground transition-[border-color,box-shadow] duration-150 placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            placeholder={t('newThread.promptPlaceholder')}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            autoFocus
          />
        </div>

        {/* Actions */}
        <DialogFooter>
          <Button variant="outline" onClick={() => cancelNewThread()}>
            {t('common.cancel')}
          </Button>
          <Button onClick={handleCreate} disabled={!prompt.trim() || creating}>
            {creating ? t('newThread.creating') : t('newThread.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
