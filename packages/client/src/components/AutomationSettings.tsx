import type { Automation } from '@funny/shared';
import { Plus } from 'lucide-react';
import { useState, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import {
  createAutomation,
  deleteAutomation,
  triggerAutomation,
  updateAutomation,
} from '@/data/automations/actions';
import { useAutomationRuns, useProjectAutomations } from '@/data/automations/hooks';
import { loadAutomationRuns, loadAutomations } from '@/data/automations/loaders';
import { buildPath } from '@/lib/url';
import { useProjectStore } from '@/stores/project-store';

import { defaultForm, type FormState } from './automation-settings/automation-form';
import { AutomationFormDialog } from './automation-settings/AutomationFormDialog';
import { AutomationRow } from './automation-settings/AutomationRow';

export function AutomationSettings() {
  const navigate = useNavigate();
  const location = useLocation();
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(defaultForm);
  const [runsAutomationId, setRunsAutomationId] = useState<string | null>(null);
  const automations = useProjectAutomations(selectedProjectId);
  const selectedAutomationRuns = useAutomationRuns(runsAutomationId);

  useEffect(() => {
    if (selectedProjectId) void loadAutomations(selectedProjectId);
  }, [selectedProjectId]);

  // Auto-open the create dialog when navigated here from the project menu's
  // "Create automation" entry. Clear the history state so a refresh/back won't
  // re-trigger it.
  useEffect(() => {
    // react-router types `location.state` as `any`; ProjectActionsMenu sets this shape.
    const navState: { openCreateAutomation?: boolean } | null = location.state;
    if (navState?.openCreateAutomation) {
      setEditingId(null);
      setForm(defaultForm);
      setDialogOpen(true);
      navigate(location.pathname + location.search, { replace: true, state: null });
    }
  }, [location, navigate]);

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
      schedule: a.schedule,
      model: a.model,
      permissionMode: a.permissionMode,
    });
    setDialogOpen(true);
  };

  const handleSave = async (andTest = false) => {
    if (!selectedProjectId || !form.name.trim() || !form.prompt.trim()) return;

    let automationId: string | null = null;

    if (editingId) {
      const updated = await updateAutomation(editingId, {
        name: form.name.trim(),
        prompt: form.prompt.trim(),
        schedule: form.schedule,
        model: form.model,
        permissionMode: form.permissionMode,
      });
      // A refused save (an invalid schedule) keeps the dialog open; the toast says why.
      if (updated.isErr()) return;
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
      if (created.isErr()) return;
      automationId = created.value.id;
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
    await deleteAutomation(a.id);
  };

  const handleTrigger = async (a: Automation) => {
    await triggerAutomation(a.id);
  };

  const handleViewRuns = (automationId: string) => {
    setRunsAutomationId(automationId);
    void loadAutomationRuns(automationId);
  };

  if (!selectedProjectId) {
    return <EmptyState padding="md" fill={false} title="Select a project to manage automations." />;
  }

  return (
    <div className="space-y-4">
      {/* Header — hidden when empty state is shown */}
      {automations.length > 0 && (
        <div className="flex items-center justify-end">
          <Button variant="outline" size="sm" gap="snug" onClick={openCreateDialog}>
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
            <Button variant="outline" size="sm" gap="snug" onClick={openCreateDialog}>
              <Plus className="icon-sm" />
              Create your first automation
            </Button>
          }
        />
      ) : (
        automations.map((a) => (
          <AutomationRow
            key={a.id}
            a={a}
            runsOpen={runsAutomationId === a.id}
            runs={selectedAutomationRuns}
            onTrigger={handleTrigger}
            onToggleEnabled={handleToggleEnabled}
            onViewRuns={handleViewRuns}
            onEdit={openEditDialog}
            onDelete={handleDelete}
            onOpenThread={(threadId) => {
              navigate(buildPath(`/projects/${selectedProjectId}/threads/${threadId}`));
            }}
            onCloseRuns={() => setRunsAutomationId(null)}
          />
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
      />
    </div>
  );
}
