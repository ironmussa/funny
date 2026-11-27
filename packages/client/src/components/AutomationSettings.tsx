import type { Automation } from '@funny/shared';
import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';

import { EmptyState } from '@/components/ui/empty-state';
import { deleteAutomation, updateAutomation } from '@/data/automations/actions';
import { useProjects } from '@/data/projects/hooks';
import { buildPath } from '@/lib/url';
import { useProjectStore } from '@/stores/project-store';

import { AutomationFormDialog } from './automation-settings/AutomationFormDialog';
import {
  AutomationGroups,
  CreateAutomationButton,
  groupAutomations,
} from './automation-settings/AutomationList';
import {
  useAutomationDialog,
  useAutomationTrigger,
  useListedAutomations,
  useRunHistory,
} from './automation-settings/use-automation-settings';

const handleToggleEnabled = async (a: Automation) => {
  await updateAutomation(a.id, { enabled: !a.enabled });
};

const handleDelete = async (a: Automation) => {
  await deleteAutomation(a.id);
};

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
  const storeProjectId = useProjectStore((s) => s.selectedProjectId);
  const selectedProjectId = projectId === undefined ? storeProjectId : projectId;

  const projects = useProjects();
  const automations = useListedAutomations(selectedProjectId, allProjects);
  const groups = useMemo(
    () => groupAutomations(allProjects, automations, projects),
    [allProjects, automations, projects],
  );
  const dialog = useAutomationDialog(selectedProjectId, projects[0]?.id ?? null);
  const { triggeringIds, handleTrigger } = useAutomationTrigger();
  const history = useRunHistory();

  if (!selectedProjectId && !allProjects) {
    return <EmptyState padding="md" fill={false} title="Select a project to manage automations." />;
  }

  return (
    <div className="space-y-4">
      {/* Header — hidden when empty state is shown */}
      {automations.length > 0 && (
        <div className="flex items-center justify-end">
          <CreateAutomationButton testId="automations-create" onClick={dialog.openCreateDialog}>
            Create
          </CreateAutomationButton>
        </div>
      )}

      {/* Automation list */}
      {automations.length === 0 ? (
        <EmptyState
          padding="md"
          fill={false}
          title="No automations yet."
          action={
            <CreateAutomationButton
              testId="automations-create-first"
              onClick={dialog.openCreateDialog}
            >
              Create your first automation
            </CreateAutomationButton>
          }
        />
      ) : (
        <AutomationGroups
          groups={groups}
          rows={{
            runsAutomationId: history.runsAutomationId,
            runs: history.runs,
            triggeringIds,
            onTrigger: handleTrigger,
            onToggleEnabled: handleToggleEnabled,
            onViewRuns: history.viewRuns,
            onEdit: dialog.openEditDialog,
            onDelete: handleDelete,
            onOpenThread: (a, threadId) => {
              navigate(buildPath(`/projects/${a.projectId}/threads/${threadId}`));
            },
            onCloseRuns: history.closeRuns,
          }}
        />
      )}

      {/* Create/Edit Dialog */}
      <AutomationFormDialog
        open={dialog.dialogOpen}
        onOpenChange={dialog.setDialogOpen}
        isEditing={dialog.isEditing}
        form={dialog.form}
        setForm={dialog.setForm}
        onSave={dialog.handleSave}
        projectField={{
          projects,
          value: dialog.formProjectId,
          onChange: dialog.setFormProjectId,
        }}
      />
    </div>
  );
}
