import type { Automation } from '@funny/shared';

import { createAutomation, updateAutomation } from '@/data/automations/actions';
import { normalizeEffort } from '@/lib/providers';

import type { FormState } from './automation-form';

/** The dialog's form for an automation being edited. */
export function formFromAutomation(a: Automation): FormState {
  return {
    name: a.name,
    prompt: a.prompt,
    schedule: a.schedule,
    provider: a.provider,
    model: a.model,
    effort: normalizeEffort(a.model, a.provider, a.effort),
    permissionMode: a.permissionMode,
  };
}

/** A form can be saved once it has a name and a prompt. */
export function isFormComplete(form: FormState): boolean {
  return Boolean(form.name.trim()) && Boolean(form.prompt.trim());
}

function fieldsOf(form: FormState) {
  return {
    name: form.name.trim(),
    prompt: form.prompt.trim(),
    schedule: form.schedule,
    provider: form.provider,
    model: form.model,
    effort: form.effort || null,
    permissionMode: form.permissionMode,
  };
}

interface SaveAutomationInput {
  form: FormState;
  /** The project the automation is created in, or moves to. */
  targetProjectId: string;
  /** The automation being edited; null creates one. */
  editingId: string | null;
  /** The project the edited automation is in now. */
  editingProjectId: string | null;
}

async function saveEdited(input: SaveAutomationInput, editingId: string) {
  const updated = await updateAutomation(editingId, {
    // Sent only when changed: the server re-checks access to the new project.
    projectId: input.targetProjectId !== input.editingProjectId ? input.targetProjectId : undefined,
    ...fieldsOf(input.form),
  });
  return updated.isErr() ? null : editingId;
}

async function saveCreated(input: SaveAutomationInput) {
  const created = await createAutomation({
    projectId: input.targetProjectId,
    ...fieldsOf(input.form),
  });
  return created.isErr() ? null : created.value.id;
}

/**
 * Updates the edited automation or creates a new one. Answers its id, or null
 * for a refused save (an invalid schedule): the action's toast says why.
 */
export function saveAutomation(input: SaveAutomationInput): Promise<string | null> {
  return input.editingId ? saveEdited(input, input.editingId) : saveCreated(input);
}
