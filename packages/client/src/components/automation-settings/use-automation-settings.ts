import type { Automation } from '@funny/shared';
import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { triggerAutomation } from '@/data/automations/actions';
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

import { defaultForm, type FormState } from './automation-form';
import { formFromAutomation, isFormComplete, saveAutomation } from './automation-save';

/** The automations the screen lists: one project's, or every project's. */
export function useListedAutomations(selectedProjectId: string | null, allProjects: boolean) {
  const projectAutomations = useProjectAutomations(selectedProjectId);
  const everyAutomation = useAllAutomations();

  useEffect(() => {
    if (allProjects) void loadAllAutomations();
    else if (selectedProjectId) void loadAutomations(selectedProjectId);
  }, [allProjects, selectedProjectId]);

  return allProjects ? everyAutomation : projectAutomations;
}

/**
 * Auto-open the create dialog when navigated here from the project menu's
 * "Create automation" entry. Clear the history state so a refresh/back won't
 * re-trigger it.
 * The dialog opens during render (once per history entry); only the history
 * rewrite, a side effect, runs in the effect.
 */
function useOpenCreateFromNavigation(openCreate: () => void) {
  const navigate = useNavigate();
  const location = useLocation();
  // react-router types `location.state` as `any`; ProjectActionsMenu sets this shape.
  const navState: { openCreateAutomation?: boolean } | null = location.state;
  const openCreateRequested = Boolean(navState?.openCreateAutomation);
  const [openedForLocationKey, setOpenedForLocationKey] = useState<string | null>(null);
  if (openCreateRequested && openedForLocationKey !== location.key) {
    setOpenedForLocationKey(location.key);
    openCreate();
  }
  useEffect(() => {
    if (openCreateRequested) {
      navigate(location.pathname + location.search, { replace: true, state: null });
    }
  }, [openCreateRequested, location.pathname, location.search, navigate]);
}

/**
 * The create / edit dialog: its form, the project it targets and saving.
 * `fallbackProjectId` is the project a new automation gets when none is selected.
 */
export function useAutomationDialog(
  selectedProjectId: string | null,
  fallbackProjectId: string | null,
) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(defaultForm);
  // The project chosen in the dialog: where a new automation is created, or
  // where an edited one moves to.
  const [formProjectId, setFormProjectId] = useState<string | null>(null);
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null);

  const openCreateIn = (projectId: string | null) => {
    setFormProjectId(projectId);
    setEditingId(null);
    setForm(defaultForm);
    setDialogOpen(true);
  };

  useOpenCreateFromNavigation(() => openCreateIn(selectedProjectId));

  const openCreateDialog = () => openCreateIn(selectedProjectId ?? fallbackProjectId);

  const openEditDialog = (a: Automation) => {
    setEditingId(a.id);
    setEditingProjectId(a.projectId);
    setFormProjectId(a.projectId);
    setForm(formFromAutomation(a));
    setDialogOpen(true);
  };

  const handleSave = async (andTest = false) => {
    const targetProjectId = formProjectId ?? selectedProjectId;
    if (!targetProjectId || !isFormComplete(form)) return;

    const automationId = await saveAutomation({
      form,
      targetProjectId,
      editingId,
      editingProjectId,
    });
    // A refused save keeps the dialog open.
    if (!automationId) return;
    setDialogOpen(false);

    if (andTest) await triggerAutomation(automationId, form.name.trim());
  };

  return {
    dialogOpen,
    setDialogOpen,
    isEditing: Boolean(editingId),
    form,
    setForm,
    formProjectId,
    setFormProjectId,
    openCreateDialog,
    openEditDialog,
    handleSave,
  };
}

/** Run-now requests: which automations wait for the server's answer. */
export function useAutomationTrigger() {
  const [triggeringIds, setTriggeringIds] = useState<ReadonlySet<string>>(() => new Set());

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

  return { triggeringIds, handleTrigger };
}

/** The one automation whose run history is open under its row. */
export function useRunHistory() {
  const [runsAutomationId, setRunsAutomationId] = useState<string | null>(null);
  const runs = useAutomationRuns(runsAutomationId);

  const viewRuns = (automationId: string) => {
    setRunsAutomationId(automationId);
    void loadAutomationRuns(automationId);
  };
  const closeRuns = () => setRunsAutomationId(null);

  return { runsAutomationId, runs, viewRuns, closeRuns };
}
