import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/stores/app-store';
import { useSettingsStore } from '@/stores/settings-store';
import { api } from '@/lib/api';
import { toast } from 'sonner';
import { GitBranch, Monitor, Sparkles, Zap, Cpu } from 'lucide-react';
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export function NewThreadDialog() {
  const { t } = useTranslation();
  const newThreadProjectId = useAppStore(s => s.newThreadProjectId);
  const cancelNewThread = useAppStore(s => s.cancelNewThread);
  const loadThreadsForProject = useAppStore(s => s.loadThreadsForProject);
  const selectThread = useAppStore(s => s.selectThread);

  const defaultThreadMode = useSettingsStore(s => s.defaultThreadMode);
  const defaultPrompt = useSettingsStore(s => s.defaultPrompt);
  const [mode, setMode] = useState<'local' | 'worktree'>(defaultThreadMode);
  const [model, setModel] = useState<'sonnet' | 'opus' | 'haiku'>('opus');
  const [branches, setBranches] = useState<string[]>([]);
  const [selectedBranch, setSelectedBranch] = useState('');
  const [prompt, setPrompt] = useState(defaultPrompt);
  const [title, setTitle] = useState('');
  const [creating, setCreating] = useState(false);

  // Load branches and detect default branch when dialog opens
  useEffect(() => {
    if (newThreadProjectId) {
      api.listBranches(newThreadProjectId).then((data) => {
        setBranches(data.branches);
        if (data.defaultBranch) {
          setSelectedBranch(data.defaultBranch);
        } else if (data.branches.length > 0) {
          setSelectedBranch(data.branches[0]);
        }
      }).catch(console.error);
    }
  }, [newThreadProjectId]);

  const handleCreate = async () => {
    if (!prompt || !newThreadProjectId || creating) return;
    setCreating(true);

    try {
      const thread = await api.createThread({
        projectId: newThreadProjectId,
        title: title || prompt,
        mode,
        model,
        baseBranch: mode === 'worktree' ? selectedBranch || undefined : undefined,
        prompt,
      });

      await loadThreadsForProject(newThreadProjectId);
      await selectThread(thread.id);
      cancelNewThread();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setCreating(false);
    }
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
            <Select value={selectedBranch} onValueChange={setSelectedBranch}>
              <SelectTrigger className="w-full h-9 text-sm">
                <SelectValue placeholder={t('newThread.selectBranch')} />
              </SelectTrigger>
              <SelectContent>
                {branches.map((b) => (
                  <SelectItem key={b} value={b}>
                    {b}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
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
