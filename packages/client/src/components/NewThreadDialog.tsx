import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/stores/app-store';
import { useSettingsStore } from '@/stores/settings-store';
import { api } from '@/lib/api';
import { toast } from 'sonner';
import { GitBranch, Monitor, Sparkles, Zap, Cpu, Check, ChevronsUpDown, Search } from 'lucide-react';
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
import { ScrollArea } from '@/components/ui/scroll-area';

export function NewThreadDialog() {
  const { t } = useTranslation();
  const newThreadProjectId = useAppStore(s => s.newThreadProjectId);
  const cancelNewThread = useAppStore(s => s.cancelNewThread);
  const loadThreadsForProject = useAppStore(s => s.loadThreadsForProject);
  const selectThread = useAppStore(s => s.selectThread);

  const defaultThreadMode = useSettingsStore(s => s.defaultThreadMode);
  const [mode, setMode] = useState<'local' | 'worktree'>(defaultThreadMode);
  const [model, setModel] = useState<'sonnet' | 'opus' | 'haiku'>('opus');
  const [branches, setBranches] = useState<string[]>([]);
  const [selectedBranch, setSelectedBranch] = useState('');
  const [prompt, setPrompt] = useState('');
  const [title, setTitle] = useState('');
  const [creating, setCreating] = useState(false);
  const [branchSearch, setBranchSearch] = useState('');
  const [branchOpen, setBranchOpen] = useState(false);
  const branchSearchRef = useRef<HTMLInputElement>(null);

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
      mode,
      model,
      baseBranch: mode === 'worktree' ? selectedBranch || undefined : undefined,
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

        {/* Mode selector */}
        <div className="flex gap-2">
          <button
            onClick={() => setMode('local')}
            className={cn(
              'flex-1 flex items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors',
              mode === 'local'
                ? 'border-primary bg-primary/10 text-primary'
                : 'border-border text-muted-foreground hover:border-primary/50 hover:bg-accent/50'
            )}
          >
            <Monitor className="h-4 w-4" />
            {t('thread.mode.local')}
          </button>
          <button
            onClick={() => setMode('worktree')}
            className={cn(
              'flex-1 flex items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors',
              mode === 'worktree'
                ? 'border-primary bg-primary/10 text-primary'
                : 'border-border text-muted-foreground hover:border-primary/50 hover:bg-accent/50'
            )}
          >
            <GitBranch className="h-4 w-4" />
            {t('thread.mode.worktree')}
          </button>
        </div>

        {/* Model selector */}
        <div>
          <label className="text-xs font-medium text-muted-foreground block mb-1">
            {t('newThread.model')}
          </label>
          <div className="flex gap-2">
            {([
              { key: 'haiku' as const, icon: Zap, label: t('thread.model.haiku') },
              { key: 'sonnet' as const, icon: Sparkles, label: t('thread.model.sonnet') },
              { key: 'opus' as const, icon: Cpu, label: t('thread.model.opus') },
            ]).map(({ key, icon: Icon, label }) => (
              <button
                key={key}
                onClick={() => setModel(key)}
                className={cn(
                  'flex-1 flex items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors',
                  model === key
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border text-muted-foreground hover:border-primary/50 hover:bg-accent/50'
                )}
              >
                <Icon className="h-4 w-4" />
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Branch selector (worktree mode) */}
        {mode === 'worktree' && (
          <div>
            <label className="text-xs font-medium text-muted-foreground block mb-1">
              {t('newThread.baseBranch')}
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
                    placeholder={t('newThread.searchBranches', 'Search branches...')}
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
        )}

        {/* Title */}
        <div>
          <label className="text-xs font-medium text-muted-foreground block mb-1">
            {t('newThread.titleOptional')}
          </label>
          <input
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground transition-[border-color,box-shadow] duration-150 focus:outline-none focus:ring-1 focus:ring-ring"
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
