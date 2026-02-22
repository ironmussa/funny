import { useState, useEffect, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/stores/app-store';
import { useSettingsStore } from '@/stores/settings-store';
import { api } from '@/lib/api';
import { toast } from 'sonner';
import { GitBranch, Check, ChevronsUpDown, Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { PROVIDERS, getModelOptions } from '@/lib/providers';

export function NewThreadDialog() {
  const { t } = useTranslation();
  const newThreadProjectId = useAppStore(s => s.newThreadProjectId);
  const cancelNewThread = useAppStore(s => s.cancelNewThread);
  const loadThreadsForProject = useAppStore(s => s.loadThreadsForProject);
  const selectThread = useAppStore(s => s.selectThread);

  const defaultThreadMode = useSettingsStore(s => s.defaultThreadMode);
  const defaultProvider = useSettingsStore(s => s.defaultProvider);
  const defaultModel = useSettingsStore(s => s.defaultModel);
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
    if (!models.some(m => m.value === model)) {
      setModel(models[0].value);
    }
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
          <label className="text-xs font-medium text-muted-foreground block mb-1">
            {t('newThread.branch', 'Branch')}
          </label>
          <Popover open={branchOpen} onOpenChange={(v) => { setBranchOpen(v); if (!v) setBranchSearch(''); }}>
            <PopoverTrigger asChild>
              <button
                className="w-full flex items-center justify-between rounded-md border border-input bg-background px-3 h-9 text-sm transition-[border-color,box-shadow] duration-150 hover:bg-accent/50 focus:outline-none focus:ring-1 focus:ring-ring"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <GitBranch className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{selectedBranch || t('newThread.selectBranch')}</span>
                </div>
                <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              </button>
            </PopoverTrigger>
            <PopoverContent
              className="w-[var(--radix-popover-trigger-width)] p-0 flex flex-col"
              style={{ maxHeight: '320px' }}
              align="start"
              onOpenAutoFocus={(e) => { e.preventDefault(); branchSearchRef.current?.focus(); }}
            >
              <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
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
              <ScrollArea className="flex-1 min-h-0" style={{ maxHeight: '260px' }}>
                <div className="p-1">
                  {branches
                    .filter((b) => !branchSearch || b.toLowerCase().includes(branchSearch.toLowerCase()))
                    .map((b) => {
                      const isSelected = b === selectedBranch;
                      return (
                        <button
                          key={b}
                          onClick={() => { setSelectedBranch(b); setBranchOpen(false); setBranchSearch(''); }}
                          className={cn(
                            'w-full flex items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors',
                            isSelected
                              ? 'bg-accent text-foreground'
                              : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                          )}
                        >
                          <GitBranch className="h-3.5 w-3.5 shrink-0 text-status-info" />
                          <span className="font-mono truncate">{b}</span>
                          {isSelected && <Check className="h-3.5 w-3.5 shrink-0 text-status-info ml-auto" />}
                        </button>
                      );
                    })}
                  {branches.filter((b) => !branchSearch || b.toLowerCase().includes(branchSearch.toLowerCase())).length === 0 && (
                    <p className="text-sm text-muted-foreground text-center py-3">
                      {t('newThread.noBranchesMatch', 'No branches match')}
                    </p>
                  )}
                </div>
              </ScrollArea>
            </PopoverContent>
          </Popover>
        </div>

        {/* Worktree toggle */}
        <label className="flex items-center gap-2 cursor-pointer">
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
          <label className="text-xs font-medium text-muted-foreground block mb-1">
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
          <label className="text-xs font-medium text-muted-foreground block mb-1">
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
          <label className="text-xs font-medium text-muted-foreground block mb-1">
            {t('newThread.prompt')}
          </label>
          <textarea
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground min-h-[120px] resize-y transition-[border-color,box-shadow] duration-150 focus:outline-none focus:ring-1 focus:ring-ring"
            placeholder={t('newThread.promptPlaceholder')}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            autoFocus
          />
        </div>

        {/* Actions */}
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => cancelNewThread()}
          >
            {t('common.cancel')}
          </Button>
          <Button
            onClick={handleCreate}
            disabled={!prompt.trim() || creating}
          >
            {creating ? t('newThread.creating') : t('newThread.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
