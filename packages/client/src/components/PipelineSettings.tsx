import type { Pipeline, AgentModel } from '@funny/shared';
import { Plus, Trash2, Pencil, Pause, Play, Shield, Wrench, Eye } from 'lucide-react';
import { useState, useEffect, useCallback } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/stores/app-store';

const MODEL_OPTIONS: { value: AgentModel; label: string }[] = [
  { value: 'haiku', label: 'Haiku' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'opus', label: 'Opus' },
];

function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
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
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function SettingRow({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border/50 px-4 py-3 last:border-b-0">
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
      </div>
      <div className="flex-shrink-0">{children}</div>
    </div>
  );
}

interface FormState {
  name: string;
  reviewModel: AgentModel;
  fixModel: AgentModel;
  maxIterations: number;
  precommitFixEnabled: boolean;
  precommitFixModel: AgentModel;
  precommitFixMaxIterations: number;
}

const defaultForm: FormState = {
  name: 'Code Review',
  reviewModel: 'sonnet',
  fixModel: 'sonnet',
  maxIterations: 10,
  precommitFixEnabled: true,
  precommitFixModel: 'sonnet',
  precommitFixMaxIterations: 3,
};

export function PipelineSettings() {
  const selectedProjectId = useAppStore((s) => s.selectedProjectId);
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(defaultForm);

  const loadPipelines = useCallback(async () => {
    if (!selectedProjectId) return;
    setLoading(true);
    const result = await api.listPipelines(selectedProjectId);
    if (result.isOk()) {
      setPipelines(result.value);
    }
    setLoading(false);
  }, [selectedProjectId]);

  useEffect(() => {
    loadPipelines();
  }, [loadPipelines]);

  const openCreateDialog = () => {
    setEditingId(null);
    setForm(defaultForm);
    setDialogOpen(true);
  };

  const openEditDialog = (p: Pipeline) => {
    setEditingId(p.id);
    setForm({
      name: p.name,
      reviewModel: (p.reviewModel as AgentModel) || 'sonnet',
      fixModel: (p.fixModel as AgentModel) || 'sonnet',
      maxIterations: p.maxIterations ?? 10,
      precommitFixEnabled: p.precommitFixEnabled ?? false,
      precommitFixModel: (p.precommitFixModel as AgentModel) || 'sonnet',
      precommitFixMaxIterations: p.precommitFixMaxIterations ?? 3,
    });
    setDialogOpen(true);
  };

  const handleSave = async () => {
    if (!selectedProjectId || !form.name.trim()) return;

    if (editingId) {
      const result = await api.updatePipeline(editingId, {
        name: form.name.trim(),
        reviewModel: form.reviewModel,
        fixModel: form.fixModel,
        maxIterations: form.maxIterations,
        precommitFixEnabled: form.precommitFixEnabled,
        precommitFixModel: form.precommitFixModel,
        precommitFixMaxIterations: form.precommitFixMaxIterations,
      });
      if (result.isOk()) {
        toast.success('Pipeline updated');
      } else {
        toast.error('Failed to update pipeline');
      }
    } else {
      const result = await api.createPipeline({
        projectId: selectedProjectId,
        name: form.name.trim(),
        reviewModel: form.reviewModel,
        fixModel: form.fixModel,
        maxIterations: form.maxIterations,
        precommitFixEnabled: form.precommitFixEnabled,
        precommitFixModel: form.precommitFixModel,
        precommitFixMaxIterations: form.precommitFixMaxIterations,
      });
      if (result.isOk()) {
        toast.success('Pipeline created');
      } else {
        toast.error('Failed to create pipeline');
      }
    }
    setDialogOpen(false);
    loadPipelines();
  };

  const handleToggleEnabled = async (p: Pipeline) => {
    const result = await api.updatePipeline(p.id, { enabled: !p.enabled });
    if (result.isOk()) {
      loadPipelines();
    }
  };

  const handleDelete = async (p: Pipeline) => {
    const result = await api.deletePipeline(p.id);
    if (result.isOk()) {
      toast.success('Pipeline deleted');
      loadPipelines();
    } else {
      toast.error('Failed to delete pipeline');
    }
  };

  if (!selectedProjectId) {
    return (
      <div className="py-6 text-center text-sm text-muted-foreground">
        Select a project to manage pipelines.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Description */}
      <div className="rounded-lg border border-border/50 bg-muted/20 px-4 py-3">
        <p className="text-sm text-muted-foreground">
          Pipelines automatically review and fix your code after each commit. When enabled, every
          successful commit triggers a Reviewer agent that analyzes the diff. If issues are found, a
          Corrector agent creates fixes in an isolated worktree.
        </p>
      </div>

      {/* Header */}
      <div className="flex items-center justify-end">
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 text-xs"
          onClick={openCreateDialog}
          data-testid="pipeline-create"
        >
          <Plus className="h-3.5 w-3.5" />
          Create Pipeline
        </Button>
      </div>

      {/* Pipeline list */}
      {loading ? (
        <div className="py-8 text-center text-sm text-muted-foreground">Loading...</div>
      ) : pipelines.length === 0 ? (
        <div className="py-8 text-center">
          <p className="mb-3 text-sm text-muted-foreground">No pipelines yet.</p>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={openCreateDialog}
            data-testid="pipeline-create-first"
          >
            <Plus className="h-3.5 w-3.5" />
            Create your first pipeline
          </Button>
        </div>
      ) : (
        pipelines.map((p) => (
          <div
            key={p.id}
            className="group rounded-lg border border-border/50 bg-card px-3 py-2.5 transition-colors hover:bg-accent/30"
            data-testid={`pipeline-item-${p.id}`}
          >
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      'h-2 w-2 rounded-full flex-shrink-0',
                      p.enabled ? 'bg-status-success/80' : 'bg-muted-foreground/30',
                    )}
                  />
                  <span className="truncate text-sm font-medium">{p.name}</span>
                </div>
                <div className="mt-1 flex items-center gap-2 pl-4">
                  <div className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Eye className="h-3 w-3" />
                    <span>Review: {p.reviewModel}</span>
                  </div>
                  <div className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Wrench className="h-3 w-3" />
                    <span>Fix: {p.fixModel}</span>
                  </div>
                  {p.precommitFixEnabled && (
                    <div className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Shield className="h-3 w-3" />
                      <span>Pre-commit fix</span>
                    </div>
                  )}
                  <span className="text-xs text-muted-foreground/70">
                    max {p.maxIterations} iterations
                  </span>
                </div>
              </div>

              <div className="flex flex-shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => handleToggleEnabled(p)}
                      className="text-muted-foreground"
                      data-testid={`pipeline-toggle-${p.id}`}
                    >
                      {p.enabled ? (
                        <Pause className="h-3.5 w-3.5" />
                      ) : (
                        <Play className="h-3.5 w-3.5" />
                      )}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{p.enabled ? 'Disable' : 'Enable'}</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => openEditDialog(p)}
                      className="text-muted-foreground"
                      data-testid={`pipeline-edit-${p.id}`}
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
                      onClick={() => handleDelete(p)}
                      className="text-muted-foreground hover:text-status-error"
                      data-testid={`pipeline-delete-${p.id}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Delete</TooltipContent>
                </Tooltip>
              </div>
            </div>
          </div>
        ))
      )}

      {/* Create/Edit dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editingId ? 'Edit Pipeline' : 'Create Pipeline'}</DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-2">
            {/* Name */}
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Name</label>
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="Code Review"
                data-testid="pipeline-form-name"
              />
            </div>

            {/* Post-commit review section */}
            <div className="overflow-hidden rounded-lg border border-border/50">
              <div className="bg-muted/30 px-3 py-2">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Post-commit Review
                </p>
              </div>
              <SettingRow title="Reviewer Model" description="Model for analyzing code (read-only)">
                <SegmentedControl
                  options={MODEL_OPTIONS}
                  value={form.reviewModel}
                  onChange={(v) => setForm({ ...form, reviewModel: v })}
                />
              </SettingRow>
              <SettingRow title="Corrector Model" description="Model for fixing issues (worktree)">
                <SegmentedControl
                  options={MODEL_OPTIONS}
                  value={form.fixModel}
                  onChange={(v) => setForm({ ...form, fixModel: v })}
                />
              </SettingRow>
              <SettingRow
                title="Max Iterations"
                description="Max review-fix cycles before giving up"
              >
                <Input
                  type="number"
                  min={1}
                  max={20}
                  value={form.maxIterations}
                  onChange={(e) =>
                    setForm({ ...form, maxIterations: parseInt(e.target.value, 10) || 10 })
                  }
                  className="h-8 w-16 text-center text-xs"
                  data-testid="pipeline-form-max-iterations"
                />
              </SettingRow>
            </div>

            {/* Pre-commit fixer section */}
            <div className="overflow-hidden rounded-lg border border-border/50">
              <div className="flex items-center justify-between bg-muted/30 px-3 py-2">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Pre-commit Auto-fix
                </p>
                <Switch
                  checked={form.precommitFixEnabled}
                  onCheckedChange={(v) => setForm({ ...form, precommitFixEnabled: v })}
                  data-testid="pipeline-form-precommit-toggle"
                />
              </div>
              {form.precommitFixEnabled && (
                <>
                  <SettingRow title="Fixer Model" description="Model for auto-fixing lint errors">
                    <SegmentedControl
                      options={MODEL_OPTIONS}
                      value={form.precommitFixModel}
                      onChange={(v) => setForm({ ...form, precommitFixModel: v })}
                    />
                  </SettingRow>
                  <SettingRow
                    title="Max Fix Attempts"
                    description="Max retries before failing the commit"
                  >
                    <Input
                      type="number"
                      min={1}
                      max={5}
                      value={form.precommitFixMaxIterations}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          precommitFixMaxIterations: parseInt(e.target.value, 10) || 3,
                        })
                      }
                      className="h-8 w-16 text-center text-xs"
                      data-testid="pipeline-form-precommit-max"
                    />
                  </SettingRow>
                </>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleSave}
              disabled={!form.name.trim()}
              data-testid="pipeline-form-save"
            >
              {editingId ? 'Save' : 'Create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
