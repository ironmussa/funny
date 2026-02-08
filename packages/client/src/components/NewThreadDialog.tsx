import { useState, useEffect } from 'react';
import { useAppStore } from '@/stores/app-store';
import { api } from '@/lib/api';
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
  const {
    newThreadProjectId,
    cancelNewThread,
    loadThreadsForProject,
    selectThread,
  } = useAppStore();

  const [mode, setMode] = useState<'local' | 'worktree'>('worktree');
  const [model, setModel] = useState<'sonnet' | 'opus' | 'haiku'>('opus');
  const [branches, setBranches] = useState<string[]>([]);
  const [selectedBranch, setSelectedBranch] = useState('');
  const [prompt, setPrompt] = useState('');
  const [title, setTitle] = useState('');
  const [creating, setCreating] = useState(false);

  // Load branches when dialog opens
  useEffect(() => {
    if (newThreadProjectId) {
      api.listBranches(newThreadProjectId).then(setBranches).catch(console.error);
    }
  }, [newThreadProjectId]);

  const handleCreate = async () => {
    if (!prompt || !newThreadProjectId || creating) return;
    setCreating(true);

    try {
      const thread = await api.createThread({
        projectId: newThreadProjectId,
        title: title || prompt.slice(0, 60),
        mode,
        model,
        branch: mode === 'worktree' ? selectedBranch || undefined : undefined,
        prompt,
      });

      await loadThreadsForProject(newThreadProjectId);
      await selectThread(thread.id);
      cancelNewThread();
    } catch (e: any) {
      alert(e.message);
    } finally {
      setCreating(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && cancelNewThread()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New Thread</DialogTitle>
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
            Local
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
            Worktree
          </button>
        </div>

        {/* Model selector */}
        <div>
          <label className="text-xs font-medium text-muted-foreground block mb-1">
            Model
          </label>
          <div className="flex gap-2">
            {([
              { key: 'haiku' as const, icon: Zap, label: 'Haiku 4.5' },
              { key: 'sonnet' as const, icon: Sparkles, label: 'Sonnet 4.5' },
              { key: 'opus' as const, icon: Cpu, label: 'Opus 4.6' },
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
              Base branch (auto-generates new branch if blank)
            </label>
            <Select value={selectedBranch} onValueChange={setSelectedBranch}>
              <SelectTrigger className="w-full h-9 text-sm">
                <SelectValue placeholder="Auto-generate branch" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value=" ">Auto-generate branch</SelectItem>
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
            Title (optional)
          </label>
          <input
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground transition-[border-color,box-shadow] duration-150 focus:outline-none focus:ring-1 focus:ring-ring"
            placeholder="Auto-generated from prompt"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>

        {/* Prompt */}
        <div>
          <label className="text-xs font-medium text-muted-foreground block mb-1">
            Prompt
          </label>
          <textarea
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground min-h-[120px] resize-y transition-[border-color,box-shadow] duration-150 focus:outline-none focus:ring-1 focus:ring-ring"
            placeholder="What should the agent do?"
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
            Cancel
          </Button>
          <Button
            onClick={handleCreate}
            disabled={!prompt.trim() || creating}
          >
            {creating ? 'Creating...' : 'Start Thread'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
