import type { ThreadPurpose } from '@funny/shared';
import { DEFAULT_MODEL, DEFAULT_PROVIDER, DEFAULT_THREAD_MODE } from '@funny/shared/models';
import { GitBranch } from 'lucide-react';
import { useState, useEffect, useMemo } from 'react';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { api } from '@/lib/api';
import { PROVIDERS, getModelOptions } from '@/lib/providers';
import { toastError } from '@/lib/toast-error';
import { useArcStore } from '@/stores/arc-store';
import { useProjectStore } from '@/stores/project-store';
import { useThreadStore } from '@/stores/thread-store';
import { useUIStore } from '@/stores/ui-store';

import { BranchPicker } from './SearchablePicker';

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
  const defaultThreadMode = project?.defaultMode ?? DEFAULT_THREAD_MODE;
  const defaultProvider = project?.defaultProvider ?? DEFAULT_PROVIDER;
  const defaultModel = project?.defaultModel ?? DEFAULT_MODEL;
  const [createWorktree, setCreateWorktree] = useState(defaultThreadMode === 'worktree');
  const [provider, setProvider] = useState<string>(defaultProvider);
  const [model, setModel] = useState<string>(defaultModel);
  const models = useMemo(() => getModelOptions(provider, t), [provider, t]);
  const [branches, setBranches] = useState<string[]>([]);
  const [selectedBranch, setSelectedBranch] = useState('');
  const [prompt, setPrompt] = useState('');
  const [title, setTitle] = useState('');
  const [creating, setCreating] = useState(false);
  const [selectedArcId, setSelectedArcId] = useState<string>('');
  const [purpose, setPurpose] = useState<ThreadPurpose>('implement');
  const [showNewArcInput, setShowNewArcInput] = useState(false);
  const [newArcName, setNewArcName] = useState('');

  const arcsByProject = useArcStore((s) => s.arcsByProject);
  const loadArcs = useArcStore((s) => s.loadArcs);
  const createArc = useArcStore((s) => s.createArc);
  const arcs = newThreadProjectId ? (arcsByProject[newThreadProjectId] ?? []) : [];

  // Reset model when provider changes and current model isn't valid for new provider
  useEffect(() => {
    if (!models.some((m) => m.value === model)) {
      setModel(models[0].value);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally only runs when provider changes to reset model; models is derived from provider
  }, [provider]);

  const [gitCurrentBranch, setGitCurrentBranch] = useState<string | null>(null);

  // Load arcs when dialog opens
  useEffect(() => {
    if (newThreadProjectId) {
      loadArcs(newThreadProjectId);
    }
  }, [newThreadProjectId, loadArcs]);

  // Load branches and detect default branch when dialog opens
  useEffect(() => {
    if (newThreadProjectId) {
      api.listBranches(newThreadProjectId).then((result) => {
        if (result.isOk()) {
          const data = result.value;
          setBranches(data.branches);
          setGitCurrentBranch(data.currentBranch);
          // Priority: project defaultBranch (user setting) > currentBranch (local mode) > git defaultBranch > first branch
          if (project?.defaultBranch && data.branches.includes(project.defaultBranch)) {
            setSelectedBranch(project.defaultBranch);
          } else if (
            !createWorktree &&
            data.currentBranch &&
            data.branches.includes(data.currentBranch)
          ) {
            setSelectedBranch(data.currentBranch);
          } else if (data.defaultBranch) {
            setSelectedBranch(data.defaultBranch);
          } else if (data.branches.length > 0) {
            setSelectedBranch(data.branches[0]);
          }
        } else {
          console.error(result.error);
        }
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally only runs when dialog opens for a project; project.defaultBranch and createWorktree are read but shouldn't trigger refetch
  }, [newThreadProjectId]);

  const handleCreate = async () => {
    if (!prompt || !newThreadProjectId || creating) return;
    setCreating(true);

    // Pre-flight checkout validation for local mode with a different branch
    if (
      !createWorktree &&
      selectedBranch &&
      gitCurrentBranch &&
      selectedBranch !== gitCurrentBranch
    ) {
      const preflight = await api.checkoutPreflight(newThreadProjectId, selectedBranch);
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
        setCreating(false);
        return;
      }
    }

    const isLocalOnlyPurpose = selectedArcId && selectedArcId !== 'none' && purpose !== 'implement';
    const result = await api.createThread({
      projectId: newThreadProjectId,
      title: title || prompt,
      mode: isLocalOnlyPurpose ? 'local' : createWorktree ? 'worktree' : 'local',
      model,
      provider,
      baseBranch: selectedBranch || undefined,
      prompt,
      arcId: selectedArcId && selectedArcId !== 'none' ? selectedArcId : undefined,
      purpose,
    });

    if (result.isErr()) {
      toastError(result.error, 'createThread');
      setCreating(false);
      return;
    }

    // Thread created — close dialog immediately (worktree setup runs in background)
    await loadThreadsForProject(newThreadProjectId);
    await selectThread(result.value.id);
    setReviewPaneOpen(false);
    cancelNewThread();
    setCreating(false);
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !creating && cancelNewThread()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('newThread.title')}</DialogTitle>
        </DialogHeader>

        {/* Branch selector */}
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">
            {t('newThread.branch', 'Branch')}
          </label>
          <BranchPicker
            branches={branches}
            selected={selectedBranch}
            onChange={setSelectedBranch}
            triggerClassName="flex h-9 w-full items-center gap-2 rounded-md border border-input bg-background px-3 text-sm transition-[border-color,box-shadow] duration-150 hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            side="bottom"
            align="start"
            testId="new-thread-branch-trigger"
          />
        </div>

        {/* Worktree toggle — hidden when purpose is explore (explore always uses local mode) */}
        {!(selectedArcId && selectedArcId !== 'none' && purpose !== 'implement') && (
          <label className="flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              data-testid="new-thread-worktree-checkbox"
              checked={createWorktree}
              onChange={(e) => setCreateWorktree(e.target.checked)}
              className="h-4 w-4 rounded border-input text-primary focus-visible:ring-1 focus-visible:ring-ring"
            />
            <div className="flex items-center gap-2 text-sm">
              <GitBranch className="h-3.5 w-3.5 text-muted-foreground" />
              <span>{t('newThread.createWorktree', 'Create isolated worktree')}</span>
            </div>
          </label>
        )}

        {/* Provider + Model selector */}
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">
            {t('newThread.model')}
          </label>
          <div className="flex gap-2">
            <Select value={provider} onValueChange={setProvider}>
              <SelectTrigger data-testid="new-thread-provider-select" className="w-[120px]">
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
              <SelectTrigger data-testid="new-thread-model-select" className="flex-1">
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

        {/* Arc + Purpose */}
        <div className="flex gap-2">
          <div className="flex-1">
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              {t('newThread.arc', 'Arc')}
            </label>
            {showNewArcInput ? (
              <div className="flex gap-1">
                <Input
                  data-testid="new-thread-new-arc-name"
                  placeholder="my-arc-name"
                  value={newArcName}
                  onChange={(e) => setNewArcName(e.target.value)}
                  className="flex-1"
                  autoFocus
                />
                <Button
                  data-testid="new-thread-new-arc-confirm"
                  size="sm"
                  variant="outline"
                  disabled={!newArcName || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(newArcName)}
                  onClick={async () => {
                    if (!newThreadProjectId || !newArcName) return;
                    const arc = await createArc(newThreadProjectId, newArcName);
                    if (arc) {
                      setSelectedArcId(arc.id);
                      setShowNewArcInput(false);
                      setNewArcName('');
                    } else {
                      toast.error(t('newThread.arcCreateFailed', 'Failed to create arc'));
                    }
                  }}
                >
                  {t('common.create', 'Create')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setShowNewArcInput(false);
                    setNewArcName('');
                  }}
                >
                  {t('common.cancel', 'Cancel')}
                </Button>
              </div>
            ) : (
              <Select
                value={selectedArcId}
                onValueChange={(v) => {
                  if (v === '__new__') {
                    setShowNewArcInput(true);
                  } else {
                    setSelectedArcId(v);
                  }
                }}
              >
                <SelectTrigger data-testid="new-thread-arc-select">
                  <SelectValue placeholder={t('newThread.noArc', 'None')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t('newThread.noArc', 'None')}</SelectItem>
                  {arcs.map((arc) => (
                    <SelectItem key={arc.id} value={arc.id}>
                      {arc.name}
                    </SelectItem>
                  ))}
                  <SelectItem value="__new__">+ {t('newThread.newArc', 'New arc')}</SelectItem>
                </SelectContent>
              </Select>
            )}
          </div>
          {selectedArcId && selectedArcId !== 'none' && !showNewArcInput && (
            <div className="w-[140px]">
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                {t('newThread.purpose', 'Purpose')}
              </label>
              <Select value={purpose} onValueChange={(v) => setPurpose(v as ThreadPurpose)}>
                <SelectTrigger data-testid="new-thread-purpose-select">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="explore">
                    {t('newThread.purposeExplore', 'Explore')}
                  </SelectItem>
                  <SelectItem value="plan">{t('newThread.purposePlan', 'Plan')}</SelectItem>
                  <SelectItem value="implement">
                    {t('newThread.purposeImplement', 'Implement')}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
        </div>

        {/* Title */}
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">
            {t('newThread.titleOptional')}
          </label>
          <Input
            data-testid="new-thread-title-input"
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
            data-testid="new-thread-prompt"
            className="min-h-[120px] w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground transition-[border-color,box-shadow] duration-150 placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            placeholder={t('newThread.promptPlaceholder')}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            autoFocus
          />
        </div>

        {/* Actions */}
        <DialogFooter>
          <Button
            data-testid="new-thread-cancel"
            variant="outline"
            onClick={() => cancelNewThread()}
          >
            {t('common.cancel')}
          </Button>
          <Button
            data-testid="new-thread-create"
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
