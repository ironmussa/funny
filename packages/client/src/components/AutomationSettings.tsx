import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppStore } from '@/stores/app-store';
import { useAutomationStore } from '@/stores/automation-store';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import {
  Plus,
  Pencil,
  Trash2,
  Play,
  Pause,
  Timer,
  Inbox,
  History,
  Monitor,
  GitBranch,
} from 'lucide-react';
import type { Automation, AutomationRun, ClaudeModel, ThreadMode, PermissionMode, AutomationSchedule } from '@a-parallel/shared';

const inputClass =
  'w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring';

const SCHEDULE_OPTIONS: { value: AutomationSchedule; label: string }[] = [
  { value: '15m', label: 'Every 15 min' },
  { value: '30m', label: 'Every 30 min' },
  { value: '1h', label: 'Every hour' },
  { value: '2h', label: 'Every 2 hours' },
  { value: '6h', label: 'Every 6 hours' },
  { value: '12h', label: 'Every 12 hours' },
  { value: '1d', label: 'Daily' },
  { value: '7d', label: 'Weekly' },
];

const MODEL_OPTIONS: { value: ClaudeModel; label: string }[] = [
  { value: 'haiku', label: 'Haiku' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'opus', label: 'Opus' },
];

function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string; icon?: React.ReactNode }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex rounded-md border border-border bg-muted/30 p-0.5">
      {options.map((opt) => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          className={cn(
            'flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-sm transition-colors',
            value === opt.value
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          {opt.icon}
          {opt.label}
        </button>
      ))}
    </div>
  );
}

interface FormState {
  name: string;
  prompt: string;
  schedule: AutomationSchedule;
  model: ClaudeModel;
  mode: ThreadMode;
  permissionMode: PermissionMode;
  baseBranch: string;
}

const defaultForm: FormState = {
  name: '',
  prompt: '',
  schedule: '1h',
  model: 'sonnet',
  mode: 'worktree',
  permissionMode: 'autoEdit',
  baseBranch: '',
};

export function AutomationSettings() {
  const navigate = useNavigate();
  const selectedProjectId = useAppStore(s => s.selectedProjectId);
  const projects = useAppStore(s => s.projects);
  const project = projects.find(p => p.id === selectedProjectId);

  const automationsByProject = useAutomationStore(s => s.automationsByProject);
  const loadAutomations = useAutomationStore(s => s.loadAutomations);
  const createAutomation = useAutomationStore(s => s.createAutomation);
  const updateAutomation = useAutomationStore(s => s.updateAutomation);
  const deleteAutomation = useAutomationStore(s => s.deleteAutomation);
  const triggerAutomation = useAutomationStore(s => s.triggerAutomation);
  const inbox = useAutomationStore(s => s.inbox);
  const inboxCount = useAutomationStore(s => s.inboxCount);
  const loadInbox = useAutomationStore(s => s.loadInbox);
  const triageRun = useAutomationStore(s => s.triageRun);
  const selectedAutomationRuns = useAutomationStore(s => s.selectedAutomationRuns);
  const loadRuns = useAutomationStore(s => s.loadRuns);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(defaultForm);
  const [branches, setBranches] = useState<string[]>([]);
  const [runsAutomationId, setRunsAutomationId] = useState<string | null>(null);
  const [showInbox, setShowInbox] = useState(false);

  const automations = selectedProjectId ? (automationsByProject[selectedProjectId] || []) : [];

  useEffect(() => {
    if (selectedProjectId) {
      loadAutomations(selectedProjectId);
    }
  }, [selectedProjectId, loadAutomations]);

  useEffect(() => {
    loadInbox();
  }, [loadInbox]);

  const loadBranches = useCallback(async () => {
    if (!selectedProjectId) return;
    try {
      const data = await api.listBranches(selectedProjectId);
      setBranches(data.branches);
      if (data.defaultBranch && !form.baseBranch) {
        setForm(f => ({ ...f, baseBranch: data.defaultBranch! }));
      }
    } catch {
      // ignore
    }
  }, [selectedProjectId, form.baseBranch]);

  const openCreateDialog = () => {
    setEditingId(null);
    setForm(defaultForm);
    setDialogOpen(true);
    loadBranches();
  };

  const openEditDialog = (a: Automation) => {
    setEditingId(a.id);
    setForm({
      name: a.name,
      prompt: a.prompt,
      schedule: a.schedule as AutomationSchedule,
      model: a.model,
      mode: a.mode,
      permissionMode: a.permissionMode,
      baseBranch: a.baseBranch || '',
    });
    setDialogOpen(true);
    loadBranches();
  };

  const handleSave = async () => {
    if (!selectedProjectId || !form.name.trim() || !form.prompt.trim()) return;

    if (editingId) {
      await updateAutomation(editingId, {
        name: form.name.trim(),
        prompt: form.prompt.trim(),
        schedule: form.schedule,
        model: form.model,
        mode: form.mode,
        permissionMode: form.permissionMode,
        baseBranch: form.baseBranch || undefined,
      });
    } else {
      await createAutomation({
        projectId: selectedProjectId,
        name: form.name.trim(),
        prompt: form.prompt.trim(),
        schedule: form.schedule,
        model: form.model,
        mode: form.mode,
        permissionMode: form.permissionMode,
        baseBranch: form.baseBranch || undefined,
      });
    }
    setDialogOpen(false);
  };

  const handleToggleEnabled = async (a: Automation) => {
    await updateAutomation(a.id, { enabled: !a.enabled });
  };

  const handleDelete = async (a: Automation) => {
    if (!selectedProjectId) return;
    await deleteAutomation(a.id, selectedProjectId);
  };

  const handleTrigger = async (a: Automation) => {
    await triggerAutomation(a.id);
  };

  const handleViewRuns = (automationId: string) => {
    setRunsAutomationId(automationId);
    loadRuns(automationId);
  };

  if (!selectedProjectId) {
    return (
      <div className="py-6 text-center text-sm text-muted-foreground">
        Select a project to manage automations.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Timer className="h-3.5 w-3.5" />
          <span>
            Automations{' '}
            {project && <span className="font-medium text-foreground">{project.name}</span>}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant={showInbox ? 'default' : 'outline'}
            size="sm"
            className="h-7 text-xs gap-1.5"
            onClick={() => setShowInbox(!showInbox)}
          >
            <Inbox className="h-3.5 w-3.5" />
            Inbox
            {inboxCount > 0 && (
              <span className="ml-1 bg-primary-foreground text-primary text-[10px] rounded-full px-1.5 min-w-[16px] text-center">
                {inboxCount}
              </span>
            )}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs gap-1.5"
            onClick={openCreateDialog}
          >
            <Plus className="h-3.5 w-3.5" />
            Create
          </Button>
        </div>
      </div>

      {/* Inbox view */}
      {showInbox && (
        <div className="space-y-2">
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            Pending Review
          </h3>
          {inbox.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">No pending reviews.</p>
          ) : (
            inbox.map(({ run, automation, thread }) => (
              <div
                key={run.id}
                className="rounded-lg border border-border/50 bg-card p-3 space-y-2"
              >
                <div className="flex items-center justify-between">
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{automation.name}</p>
                    <p className="text-xs text-muted-foreground truncate">{thread.title}</p>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className={cn(
                      'text-[10px] px-1.5 py-0.5 rounded-full',
                      run.hasFindings
                        ? 'bg-amber-500/10 text-amber-500'
                        : 'bg-muted text-muted-foreground'
                    )}>
                      {run.hasFindings ? 'Has findings' : 'No findings'}
                    </span>
                    <span className="text-[10px] text-muted-foreground">
                      {run.completedAt ? new Date(run.completedAt).toLocaleString() : ''}
                    </span>
                  </div>
                </div>
                {run.summary && (
                  <p className="text-xs text-muted-foreground line-clamp-2">{run.summary}</p>
                )}
                <div className="flex items-center gap-2 justify-end">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 text-xs"
                    onClick={() => {
                      navigate(`/projects/${thread.projectId}/threads/${thread.id}`);
                    }}
                  >
                    View Thread
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 text-xs"
                    onClick={() => triageRun(run.id, 'dismissed')}
                  >
                    Dismiss
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-6 text-xs"
                    onClick={() => triageRun(run.id, 'reviewed')}
                  >
                    Mark Reviewed
                  </Button>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {/* Automation list */}
      {!showInbox && (
        <>
          {automations.length === 0 ? (
            <div className="text-center py-8">
              <p className="text-sm text-muted-foreground mb-3">No automations yet.</p>
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={openCreateDialog}
              >
                <Plus className="h-3.5 w-3.5" />
                Create your first automation
              </Button>
            </div>
          ) : (
            automations.map((a) => (
              <div key={a.id} className="space-y-1">
                <div
                  className="group flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg border border-border/50 bg-card hover:bg-accent/30 transition-colors"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className={cn(
                        'h-2 w-2 rounded-full flex-shrink-0',
                        a.enabled ? 'bg-green-400' : 'bg-muted-foreground/30'
                      )} />
                      <span className="text-sm font-medium truncate">{a.name}</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground flex-shrink-0">
                        {SCHEDULE_OPTIONS.find(s => s.value === a.schedule)?.label || a.schedule}
                      </span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground flex-shrink-0">
                        {a.model}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground truncate mt-0.5 pl-4">{a.prompt}</p>
                    {a.lastRunAt && (
                      <p className="text-[10px] text-muted-foreground/70 mt-0.5 pl-4">
                        Last run: {new Date(a.lastRunAt).toLocaleString()}
                      </p>
                    )}
                  </div>

                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => handleTrigger(a)}
                          className="text-green-400 hover:text-green-300"
                        >
                          <Play className="h-3.5 w-3.5" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Run Now</TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => handleToggleEnabled(a)}
                          className="text-muted-foreground"
                        >
                          {a.enabled ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{a.enabled ? 'Pause' : 'Enable'}</TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => handleViewRuns(a.id)}
                          className="text-muted-foreground"
                        >
                          <History className="h-3.5 w-3.5" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Run History</TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => openEditDialog(a)}
                          className="text-muted-foreground"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Edit</TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => handleDelete(a)}
                          className="text-muted-foreground hover:text-red-400"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Delete</TooltipContent>
                    </Tooltip>
                  </div>
                </div>

                {/* Inline run history */}
                {runsAutomationId === a.id && (
                  <div className="ml-4 space-y-1">
                    {selectedAutomationRuns.length === 0 ? (
                      <p className="text-xs text-muted-foreground py-2 pl-2">No runs yet.</p>
                    ) : (
                      selectedAutomationRuns.slice(0, 10).map((run) => (
                        <div
                          key={run.id}
                          className="flex items-center justify-between gap-2 px-2 py-1.5 rounded border border-border/30 text-xs"
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <span className={cn(
                              'h-1.5 w-1.5 rounded-full flex-shrink-0',
                              run.status === 'running' ? 'bg-blue-400 animate-pulse' :
                              run.status === 'completed' ? 'bg-green-400' :
                              run.status === 'failed' ? 'bg-red-400' : 'bg-muted-foreground/30'
                            )} />
                            <span className="text-muted-foreground truncate">
                              {new Date(run.startedAt).toLocaleString()}
                            </span>
                            <span className="text-muted-foreground/70">{run.status}</span>
                          </div>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-5 text-[10px] px-1.5"
                            onClick={() => {
                              navigate(`/projects/${selectedProjectId}/threads/${run.threadId}`);
                            }}
                          >
                            View
                          </Button>
                        </div>
                      ))
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-5 text-[10px] w-full"
                      onClick={() => setRunsAutomationId(null)}
                    >
                      Close
                    </Button>
                  </div>
                )}
              </div>
            ))
          )}
        </>
      )}

      {/* Create/Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editingId ? 'Edit Automation' : 'Create Automation'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-xs text-muted-foreground block mb-1">Name</label>
              <input
                className={inputClass}
                placeholder="e.g. Daily Issue Triage"
                value={form.name}
                onChange={(e) => setForm(f => ({ ...f, name: e.target.value }))}
                autoFocus
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground block mb-1">Prompt</label>
              <textarea
                className={`${inputClass} min-h-[100px] resize-y`}
                placeholder="What should the agent do?"
                value={form.prompt}
                onChange={(e) => setForm(f => ({ ...f, prompt: e.target.value }))}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-muted-foreground block mb-1">Schedule</label>
                <Select value={form.schedule} onValueChange={(v) => setForm(f => ({ ...f, schedule: v as AutomationSchedule }))}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SCHEDULE_OPTIONS.map(opt => (
                      <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-xs text-muted-foreground block mb-1">Model</label>
                <SegmentedControl
                  options={MODEL_OPTIONS}
                  value={form.model}
                  onChange={(v) => setForm(f => ({ ...f, model: v }))}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-muted-foreground block mb-1">Mode</label>
                <SegmentedControl
                  options={[
                    { value: 'local' as const, label: 'Local', icon: <Monitor className="h-3 w-3" /> },
                    { value: 'worktree' as const, label: 'Worktree', icon: <GitBranch className="h-3 w-3" /> },
                  ]}
                  value={form.mode}
                  onChange={(v) => setForm(f => ({ ...f, mode: v }))}
                />
              </div>
              {form.mode === 'worktree' && (
                <div>
                  <label className="text-xs text-muted-foreground block mb-1">Base Branch</label>
                  <Select value={form.baseBranch} onValueChange={(v) => setForm(f => ({ ...f, baseBranch: v }))}>
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Select branch" />
                    </SelectTrigger>
                    <SelectContent>
                      {branches.map(b => (
                        <SelectItem key={b} value={b}>{b}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={handleSave}
              disabled={!form.name.trim() || !form.prompt.trim()}
            >
              {editingId ? 'Save' : 'Create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
