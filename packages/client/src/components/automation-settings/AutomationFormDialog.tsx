import type { AgentProvider } from '@funny/shared';
import { getDefaultModel } from '@funny/shared/models';
import { Play } from 'lucide-react';
import { useState, type Dispatch, type SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';

import { ModelCombobox } from '@/components/general-settings-project/ModelCombobox';
import { useProviderModelOptions } from '@/components/general-settings-project/use-provider-model-options';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { getEffortLevels, normalizeEffort, PROVIDERS } from '@/lib/providers';

import { SCHEDULE_PRESETS, type FormState } from './automation-form';

interface AutomationFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isEditing: boolean;
  form: FormState;
  setForm: Dispatch<SetStateAction<FormState>>;
  onSave: (andTest: boolean) => void;
  /** The project the automation belongs to (create) or moves to (edit). */
  projectField?: {
    projects: { id: string; name: string }[];
    value: string | null;
    onChange: (projectId: string) => void;
  };
}

/** Provider, model and effort, chosen as in a project's default model setting. */
function ModelFields({ form, setForm }: Pick<AutomationFormDialogProps, 'form' | 'setForm'>) {
  const { t } = useTranslation();
  const modelOptions = useProviderModelOptions(form.provider);
  const effortLevels = getEffortLevels(form.model, form.provider);
  return (
    <>
      <fieldset>
        <legend className="settings-label">Model</legend>
        <div className="flex items-center gap-2" data-testid="automation-form-model">
          <ModelCombobox
            value={form.provider}
            onChange={(v) => {
              // SAFETY: the combobox only offers PROVIDERS, whose values are AgentProviders.
              const provider = v as AgentProvider;
              const model = getDefaultModel(provider);
              setForm((f) => ({
                ...f,
                provider,
                model,
                effort: normalizeEffort(model, provider, f.effort),
              }));
            }}
            options={PROVIDERS.map((p) => ({ value: p.value, label: p.label }))}
            placeholder={t('settings.selectProvider')}
            searchPlaceholder={t('settings.searchProvider')}
          />
          <ModelCombobox
            value={form.model}
            onChange={(model) =>
              setForm((f) => ({
                ...f,
                model,
                effort: normalizeEffort(model, f.provider, f.effort),
              }))
            }
            options={modelOptions}
            placeholder={t('settings.selectModel')}
            searchPlaceholder={t('settings.searchModel')}
          />
        </div>
      </fieldset>
      {effortLevels.length > 0 && (
        <fieldset>
          <legend className="settings-label">Effort</legend>
          <ToggleGroup
            size="xs"
            segmented
            className="w-fit"
            value={[form.effort]}
            onValueChange={([effort]) => {
              // Clicking the pressed item would clear it; an effort stays selected.
              if (effort) setForm((f) => ({ ...f, effort }));
            }}
            data-testid="automation-form-effort"
          >
            {effortLevels.map((level) => (
              <ToggleGroupItem
                key={level.value}
                value={level.value}
                data-testid={`automation-form-effort-${level.value}`}
              >
                {t(`settings.effort.${level.value}`, level.label)}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </fieldset>
      )}
    </>
  );
}

export function ScheduleField({
  form,
  setForm,
}: Pick<AutomationFormDialogProps, 'form' | 'setForm'>) {
  const isPreset = SCHEDULE_PRESETS.some((p) => p.value === form.schedule);
  // Choosing "Custom cron…" keeps the current expression, which may still match a
  // preset, so the custom mode needs its own flag or the select snaps back.
  const [customMode, setCustomMode] = useState(!isPreset);
  const showCustom = customMode || !isPreset;
  return (
    <fieldset>
      <legend className="settings-label">Schedule</legend>
      <Select
        value={showCustom ? '__custom__' : form.schedule}
        onValueChange={(v) => {
          if (v === '__custom__') {
            setCustomMode(true);
            return;
          }
          setCustomMode(false);
          setForm((f) => ({ ...f, schedule: v }));
        }}
      >
        <SelectTrigger className="w-full" data-testid="automation-schedule-select">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {SCHEDULE_PRESETS.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              {opt.label}
            </SelectItem>
          ))}
          <SelectItem value="__custom__">Custom cron…</SelectItem>
        </SelectContent>
      </Select>
      {showCustom && (
        <Input
          mono
          size="xs"
          className="mt-1.5"
          placeholder="*/30 * * * *"
          data-testid="automation-schedule-custom"
          autoFocus={customMode && isPreset}
          value={form.schedule}
          onChange={(e) => setForm((f) => ({ ...f, schedule: e.target.value }))}
        />
      )}
      <p className="text-muted-foreground mt-1 text-xs">Cron: min hour day month weekday</p>
    </fieldset>
  );
}

export function AutomationFormDialog({
  open,
  onOpenChange,
  isEditing,
  form,
  setForm,
  onSave,
  projectField,
}: AutomationFormDialogProps) {
  const needsProject = Boolean(projectField && !projectField.value);
  const cannotSave = !form.name.trim() || !form.prompt.trim() || needsProject;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEditing ? 'Edit Automation' : 'Create Automation'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          {projectField && (
            <div>
              <label htmlFor="automation-project" className="settings-label">
                Project
              </label>
              <Select value={projectField.value ?? undefined} onValueChange={projectField.onChange}>
                <SelectTrigger
                  id="automation-project"
                  className="w-full"
                  data-testid="automation-form-project"
                >
                  <SelectValue placeholder="Select a project" />
                </SelectTrigger>
                <SelectContent>
                  {projectField.projects.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div>
            <label htmlFor="automation-name" className="settings-label">
              Name
            </label>
            <Input
              id="automation-name"
              placeholder="e.g. Daily Issue Triage"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              autoFocus
            />
          </div>
          <div>
            <label htmlFor="automation-prompt" className="settings-label">
              Prompt
            </label>
            <Textarea
              id="automation-prompt"
              textSize="sm"
              className="min-h-[45vh] resize-y"
              placeholder="What should the agent do?"
              value={form.prompt}
              onChange={(e) => setForm((f) => ({ ...f, prompt: e.target.value }))}
            />
          </div>
          <ScheduleField form={form} setForm={setForm} />
          <ModelFields form={form} setForm={setForm} />
          <p className="text-muted-foreground text-xs">
            Automations run locally in read-only mode (no file writes).
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onSave(true)}
            disabled={cannotSave}
            gap="snug"
          >
            <Play className="icon-xs" />
            {isEditing ? 'Save & Test' : 'Create & Test'}
          </Button>
          <Button size="sm" onClick={() => onSave(false)} disabled={cannotSave}>
            {isEditing ? 'Save' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
