import type { Automation } from '@funny/shared';
import { Plus } from 'lucide-react';
import { useState, useEffect, useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import {
  createAutomation,
  deleteAutomation,
  triggerAutomation,
  updateAutomation,
} from '@/data/automations/actions';
import {
  useAllAutomations,
  useAutomationRuns,
  useProjectAutomations,
} from '@/data/automations/hooks';
import {
  loadAllAutomations,
  loadAutomationRuns,
  loadAutomations,
} from '@/data/automations/loaders';
import { useProjects } from '@/data/projects/hooks';
import { normalizeEffort } from '@/lib/providers';
import { buildPath } from '@/lib/url';
import { cn } from '@/lib/utils';
import { useProjectStore } from '@/stores/project-store';

import { defaultForm, type FormState } from './automation-settings/automation-form';
import { AutomationFormDialog } from './automation-settings/AutomationFormDialog';
import { AutomationRow } from './automation-settings/AutomationRow';

interface AutomationSettingsProps {
  /** Project whose automations to manage. Defaults to the selected project
   *  (settings page); the automation inbox passes its own choice. */
  projectId?: string | null;
  /** List the automations of every project, grouped by project.
   *  Overrides `projectId`. */
  allProjects?: boolean;
}

export function AutomationSettings({
  projectId,
  allProjects = false,
}: AutomationSettingsProps = {}) {
  const navigate = useNavigate();
  const location = useLocation();
  const storeProjectId = useProjectStore((s) => s.selectedProjectId);
  const selectedProjectId = projectId === undefined ? storeProjectId : projectId;

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(defaultForm);
  const [runsAutomationId, setRunsAutomationId] = useState<string | null>(null);
  // Automations whose run-now request is waiting for the server's answer.
  const [triggeringIds, setTriggeringIds] = useState<ReadonlySet<string>>(() => new Set());
  const projects = useProjects();
  // The project chosen in the dialog: where a new automation is created, or
  // where an edited one moves to.
  const [formProjectId, setFormProjectId] = useState<string | null>(null);
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null);
  const projectAutomations = useProjectAutomations(selectedProjectId);
  const everyAutomation = useAllAutomations();
  const automations = allProjects ? everyAutomation : projectAutomations;
  const selectedAutomationRuns = useAutomationRuns(runsAutomationId);

  useEffect(() => {
    if (allProjects) void loadAllAutomations();
    else if (selectedProjectId) void loadAutomations(selectedProjectId);
  }, [allProjects, selectedProjectId]);

  const groups = useMemo(() => {
    if (!allProjects) return [{ project: null, items: automations }];
    return projects
      .map((project) => ({ project, items: automations.filter((a) => a.projectId === project.id) }))
      .filter((g) => g.items.length > 0);
  }, [allProjects, automations, projects]);

  // Auto-open the create dialog when navigated here from the project menu's
  // "Create automation" entry. Clear the history state so a refresh/back won't
  // re-trigger it.
  // The dialog opens during render (once per history entry); only the history
  // rewrite, a side effect, runs in the effect.
  // react-router types `location.state` as `any`; ProjectActionsMenu sets this shape.
  const navState: { openCreateAutomation?: boolean } | null = location.state;
  const openCreateRequested = Boolean(navState?.openCreateAutomation);
  const [openedForLocationKey, setOpenedForLocationKey] = useState<string | null>(null);
  if (openCreateRequested && openedForLocationKey !== location.key) {
    setOpenedForLocationKey(location.key);
    setFormProjectId(selectedProjectId);
    setEditingId(null);
    setForm(defaultForm);
    setDialogOpen(true);
  }
  useEffect(() => {
    if (openCreateRequested) {
      navigate(location.pathname + location.search, { replace: true, state: null });
    }
  }, [openCreateRequested, location.pathname, location.search, navigate]);

  const openCreateDialog = () => {
    setFormProjectId(selectedProjectId ?? projects[0]?.id ?? null);
    setEditingId(null);
    setForm(defaultForm);
    setDialogOpen(true);
  };

  const openEditDialog = (a: Automation) => {
    setEditingId(a.id);
    setEditingProjectId(a.projectId);
    setFormProjectId(a.projectId);
    setForm({
      name: a.name,
      prompt: a.prompt,
      schedule: a.schedule,
      provider: a.provider,
      model: a.model,
      effort: normalizeEffort(a.model, a.provider, a.effort),
      permissionMode: a.permissionMode,
    });
    setDialogOpen(true);
  };

  const handleSave = async (andTest = false) => {
    const targetProjectId = formProjectId ?? selectedProjectId;
    if (!targetProjectId || !form.name.trim() || !form.prompt.trim()) return;

    let automationId: string | null = null;

    if (editingId) {
      const updated = await updateAutomation(editingId, {
        // Sent only when changed: the server re-checks access to the new project.
        projectId: targetProjectId !== editingProjectId ? targetProjectId : undefined,
        name: form.name.trim(),
        prompt: form.prompt.trim(),
        schedule: form.schedule,
        provider: form.provider,
        model: form.model,
        effort: form.effort || null,
        permissionMode: form.permissionMode,
      });
      // A refused save (an invalid schedule) keeps the dialog open; the toast says why.
      if (updated.isErr()) return;
      automationId = editingId;
    } else {
      const created = await createAutomation({
        projectId: targetProjectId,
        name: form.name.trim(),
        prompt: form.prompt.trim(),
        schedule: form.schedule,
        provider: form.provider,
        model: form.model,
        effort: form.effort || null,
        permissionMode: form.permissionMode,
      });
      if (created.isErr()) return;
      automationId = created.value.id;
    }
    setDialogOpen(false);

    if (andTest && automationId) {
      await triggerAutomation(automationId, form.name.trim());
    }
  };

  const handleToggleEnabled = async (a: Automation) => {
    await updateAutomation(a.id, { enabled: !a.enabled });
  };

  const handleDelete = async (a: Automation) => {
    await deleteAutomation(a.id);
  };

  const handleTrigger = async (a: Automation) => {
    if (triggeringIds.has(a.id)) return;
    setTriggeringIds((prev) => new Set(prev).add(a.id));
    await triggerAutomation(a.id, a.name);
    setTriggeringIds((prev) => {
      const next = new Set(prev);
      next.delete(a.id);
      return next;
    });
  };

  const handleViewRuns = (automationId: string) => {
    setRunsAutomationId(automationId);
    void loadAutomationRuns(automationId);
  };

  if (!selectedProjectId && !allProjects) {
    return <EmptyState padding="md" fill={false} title="Select a project to manage automations." />;
  }

  return (
    <div className="space-y-4">
      {/* Header — hidden when empty state is shown */}
      {automations.length > 0 && (
        <div className="flex items-center justify-end">
          <Button
            variant="outline"
            size="sm"
            gap="snug"
            data-testid="automations-create"
            onClick={openCreateDialog}
          >
            <Plus className="icon-sm" />
            Create
          </Button>
        </div>
      )}

      {/* Automation list */}
      {automations.length === 0 ? (
        <EmptyState
          padding="md"
          fill={false}
          title="No automations yet."
          action={
            <Button
              variant="outline"
              size="sm"
              gap="snug"
              data-testid="automations-create-first"
              onClick={openCreateDialog}
            >
              <Plus className="icon-sm" />
              Create your first automation
            </Button>
          }
        />
      ) : (
        groups.map(({ project, items }) => (
          <section
            key={project?.id ?? 'project'}
            className={cn(project ? 'space-y-2' : 'space-y-4')}
            data-testid={project ? `automations-group-${project.id}` : undefined}
          >
            {project && (
              <h3 className="text-muted-foreground text-xs font-medium">{project.name}</h3>
            )}
            {items.map((a) => (
              <AutomationRow
                key={a.id}
                a={a}
                runsOpen={runsAutomationId === a.id}
                runs={selectedAutomationRuns}
                onTrigger={handleTrigger}
                triggering={triggeringIds.has(a.id)}
                onToggleEnabled={handleToggleEnabled}
                onViewRuns={handleViewRuns}
                onEdit={openEditDialog}
                onDelete={handleDelete}
                onOpenThread={(threadId) => {
                  navigate(buildPath(`/projects/${a.projectId}/threads/${threadId}`));
                }}
                onCloseRuns={() => setRunsAutomationId(null)}
              />
            ))}
          </section>
        ))
      )}

      {/* Create/Edit Dialog */}
      <AutomationFormDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        isEditing={Boolean(editingId)}
        form={form}
        setForm={setForm}
        onSave={handleSave}
        projectField={{ projects, value: formProjectId, onChange: setFormProjectId }}
      />
    </div>
  );
}
