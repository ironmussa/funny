import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppStore } from '@/stores/app-store';
import { useAutomationStore } from '@/stores/automation-store';
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
  History,
} from 'lucide-react';
import type { Automation, AutomationRun, ClaudeModel, PermissionMode, AutomationSchedule } from '@a-parallel/shared';

const inputClass =
  'w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring';

const SCHEDULE_PRESETS: { value: string; label: string }[] = [
  { value: '*/15 * * * *', label: 'Every 15 min' },
  { value: '*/30 * * * *', label: 'Every 30 min' },
  { value: '0 * * * *', label: 'Every hour' },
  { value: '0 */2 * * *', label: 'Every 2 hours' },
  { value: '0 */6 * * *', label: 'Every 6 hours' },
  { value: '0 */12 * * *', label: 'Every 12 hours' },
  { value: '0 9 * * *', label: 'Daily at 9am' },
  { value: '0 9 * * 1', label: 'Weekly (Mon 9am)' },
];

/** Find a friendly label for a cron expression, or show the raw expression */
function getScheduleLabel(cron: string): string {
  const preset = SCHEDULE_PRESETS.find(p => p.value === cron);
  return preset?.label ?? cron;
}

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
  permissionMode: PermissionMode;
}

const defaultForm: FormState = {
  name: '',
  prompt: '',
  schedule: '0 * * * *',
  model: 'sonnet',
  permissionMode: 'autoEdit',
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
  const selectedAutomationRuns = useAutomationStore(s => s.selectedAutomationRuns);
  const loadRuns = useAutomationStore(s => s.loadRuns);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(defaultForm);
  const [runsAutomationId, setRunsAutomationId] = useState<string | null>(null);
  const automations = selectedProjectId ? (automationsByProject[selectedProjectId] || []) : [];

  useEffect(() => {
    if (selectedProjectId) {
      loadAutomations(selectedProjectId);
    }
  }, [selectedProjectId, loadAutomations]);

  const openCreateDialog = () => {
    setEditingId(null);
    setForm(defaultForm);
    setDialogOpen(true);
  };

  const openEditDialog = (a: Automation) => {
    setEditingId(a.id);
    setForm({
      name: a.name,
      prompt: a.prompt,
      schedule: a.schedule as AutomationSchedule,
      model: a.model,
      permissionMode: a.permissionMode,
    });
    setDialogOpen(true);
  };

  const handleSave = async (andTest = false) => {
    if (!selectedProjectId || !form.name.trim() || !form.prompt.trim()) return;

    let automationId: string | null = null;

    if (editingId) {
      await updateAutomation(editingId, {
        name: form.name.trim(),
        prompt: form.prompt.trim(),
        schedule: form.schedule,
        model: form.model,
        permissionMode: form.permissionMode,
      });
      automationId = editingId;
    } else {
      const created = await createAutomation({
        projectId: selectedProjectId,
        name: form.name.trim(),
        prompt: form.prompt.trim(),
        schedule: form.schedule,
        model: form.model,
        permissionMode: form.permissionMode,
      });
      automationId = created?.id ?? null;
    }
    setDialogOpen(false);

    if (andTest && automationId) {
      await triggerAutomation(automationId);
    }
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

      {/* Automation list */}
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
                        {getScheduleLabel(a.schedule)}
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
                <Select
                  value={SCHEDULE_PRESETS.some(p => p.value === form.schedule) ? form.schedule : '__custom__'}
                  onValueChange={(v) => {
                    if (v !== '__custom__') setForm(f => ({ ...f, schedule: v }));
                  }}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SCHEDULE_PRESETS.map(opt => (
                      <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                    ))}
                    <SelectItem value="__custom__">Custom cron...</SelectItem>
                  </SelectContent>
                </Select>
                {!SCHEDULE_PRESETS.some(p => p.value === form.schedule) && (
                  <input
                    className={`${inputClass} mt-1.5 font-mono text-xs`}
                    placeholder="*/30 * * * *"
                    value={form.schedule}
                    onChange={(e) => setForm(f => ({ ...f, schedule: e.target.value }))}
                  />
                )}
                <p className="text-[10px] text-muted-foreground mt-1">
                  Cron: min hour day month weekday
                </p>
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
            <p className="text-[10px] text-muted-foreground">
              Automations run locally in read-only mode (no file writes).
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleSave(true)}
              disabled={!form.name.trim() || !form.prompt.trim()}
              className="gap-1.5"
            >
              <Play className="h-3 w-3" />
              {editingId ? 'Save & Test' : 'Create & Test'}
            </Button>
            <Button
              size="sm"
              onClick={() => handleSave(false)}
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
