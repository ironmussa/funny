/**
 * The schedule triggers of the caller's issue factory (change flow-triggers):
 * a cron schedule that starts a flow without an issue, with input values. The
 * server checks the schedule, the inputs and that the flow needs no issue; its
 * message is shown. The same dialog starts a flow once ("Run a flow").
 */
import { Play, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  FactoryFlowFields,
  typedFlowInputs,
  useFactoryFlowReady,
} from '@/components/factory-flows/FactoryFlowFields';
import { RunFactoryFlowDialog } from '@/components/factory-flows/RunFactoryFlowDialog';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogCancelButton,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  removeFactoryTrigger,
  saveFactoryTrigger,
  type FactoryTriggerDraft,
} from '@/data/factory/actions';
import { useFactoryTriggers } from '@/data/factory/hooks';
import { useProjectById } from '@/data/projects/hooks';
import type { FactoryTrigger } from '@/lib/api/factory';
import { toastError } from '@/lib/toast-error';

import { ProjectSettingRow } from './setting-primitives';

const EMPTY_DRAFT: FactoryTriggerDraft = {
  name: '',
  schedule: '',
  flowName: '',
  inputs: {},
  enabled: true,
};

const draftOf = (trigger: FactoryTrigger): FactoryTriggerDraft => ({
  id: trigger.id,
  name: trigger.name,
  schedule: trigger.schedule,
  flowName: trigger.flowName,
  inputs: trigger.inputs,
  enabled: trigger.enabled,
});

function TriggerDialog({
  projectId,
  initial,
  onClose,
}: {
  projectId: string;
  initial: FactoryTriggerDraft;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(initial);
  const [saving, setSaving] = useState(false);
  const flowReady = useFactoryFlowReady(projectId, draft.flowName, draft.inputs);
  const ready = flowReady && draft.name.trim() !== '' && draft.schedule.trim() !== '';

  const save = async () => {
    setSaving(true);
    const saved = await saveFactoryTrigger(projectId, {
      ...draft,
      inputs: typedFlowInputs(draft.inputs),
    });
    setSaving(false);
    if (saved.isErr()) {
      toastError(saved.error, 'factory');
      return;
    }
    onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent data-testid="settings-factory-trigger-dialog">
        <DialogHeader>
          <DialogTitle>
            {initial.id
              ? t('settings.projectFactoryTriggerEdit', 'Edit schedule')
              : t('settings.projectFactoryTriggerAdd', 'Add schedule')}
          </DialogTitle>
          <DialogDescription>
            {t(
              'settings.projectFactoryTriggerDialogDesc',
              'Starts the flow at each occurrence, as you. Input values are shown to every member of the project: do not put secrets in them.',
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">
              {t('settings.projectFactoryTriggerName', 'Name')}
            </span>
            <Input
              value={draft.name}
              maxLength={80}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              data-testid="settings-factory-trigger-name"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">
              {t(
                'settings.projectFactoryTriggerSchedule',
                'Schedule (cron, in the server’s time zone)',
              )}
            </span>
            <Input
              value={draft.schedule}
              placeholder="0 3 * * *"
              mono
              onChange={(e) => setDraft({ ...draft, schedule: e.target.value })}
              data-testid="settings-factory-trigger-schedule"
            />
          </label>
          <FactoryFlowFields
            projectId={projectId}
            flowName={draft.flowName}
            onFlowChange={(flowName) => setDraft({ ...draft, flowName, inputs: {} })}
            inputs={draft.inputs}
            onInputsChange={(inputs) => setDraft({ ...draft, inputs })}
            testIdPrefix="settings-factory-trigger"
          />
          <label className="flex items-center justify-between gap-2 text-xs">
            <span>{t('settings.projectFactoryTriggerEnabled', 'Enabled')}</span>
            <Switch
              checked={draft.enabled}
              onCheckedChange={(enabled) => setDraft({ ...draft, enabled })}
              data-testid="settings-factory-trigger-enabled"
            />
          </label>
        </div>
        <DialogFooter>
          <DialogCancelButton data-testid="settings-factory-trigger-cancel">
            {t('common.cancel', 'Cancel')}
          </DialogCancelButton>
          <Button
            onClick={() => void save()}
            disabled={!ready || saving}
            data-testid="settings-factory-trigger-save"
          >
            {t('common.save', 'Save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TriggerRow({
  projectId,
  trigger,
  onEdit,
}: {
  projectId: string;
  trigger: FactoryTrigger;
  onEdit: () => void;
}) {
  const { t } = useTranslation();
  const remove = () =>
    void removeFactoryTrigger(projectId, trigger.id).orTee((error) => toastError(error, 'factory'));
  const next = trigger.nextRunAt
    ? t('settings.projectFactoryTriggerNext', 'next {{when}}', {
        when: new Date(trigger.nextRunAt).toLocaleString(),
      })
    : t('settings.projectFactoryTriggerOff', 'off');
  return (
    <li
      className="border-border/50 flex items-center gap-2 border-b px-4 py-2 text-xs last:border-b-0"
      data-testid={`settings-factory-trigger-${trigger.id}`}
    >
      <button
        type="button"
        className="text-foreground min-w-0 flex-1 truncate text-left text-sm hover:underline"
        onClick={onEdit}
        data-testid={`settings-factory-trigger-edit-${trigger.id}`}
      >
        {trigger.name}
      </button>
      <span className="text-muted-foreground shrink-0 font-mono">{trigger.schedule}</span>
      <span className="text-muted-foreground shrink-0 font-mono">{trigger.flowName}</span>
      <span className="text-muted-foreground shrink-0">{next}</span>
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={remove}
        aria-label={t('settings.projectFactoryTriggerRemove', 'Remove schedule')}
        data-testid={`settings-factory-trigger-remove-${trigger.id}`}
      >
        <Trash2 className="icon-sm" />
      </Button>
    </li>
  );
}

export function ProjectFactoryTriggers({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const triggers = useFactoryTriggers(projectId);
  const project = useProjectById(projectId);
  const [editing, setEditing] = useState<FactoryTriggerDraft | null>(null);
  const [running, setRunning] = useState(false);

  return (
    <>
      <ProjectSettingRow
        settingId="factory.triggers"
        title={t('settings.projectFactoryTriggers', 'Schedules')}
        description={t(
          'settings.projectFactoryTriggersDesc',
          'Start a flow on a schedule, or once, without an issue. Such a run can open a pull request and never merges one by itself',
        )}
      >
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="xs"
            onClick={() => setRunning(true)}
            data-testid="settings-factory-run-flow"
          >
            <Play className="icon-sm" />
            {t('factory.runFlow.title', 'Run a flow')}
          </Button>
          <Button
            variant="outline"
            size="xs"
            onClick={() => setEditing(EMPTY_DRAFT)}
            data-testid="settings-factory-trigger-add"
          >
            <Plus className="icon-sm" />
            {t('settings.projectFactoryTriggerAdd', 'Add schedule')}
          </Button>
        </div>
      </ProjectSettingRow>
      {triggers && triggers.length > 0 && (
        <ul data-testid="settings-factory-triggers">
          {triggers.map((trigger) => (
            <TriggerRow
              key={trigger.id}
              projectId={projectId}
              trigger={trigger}
              onEdit={() => setEditing(draftOf(trigger))}
            />
          ))}
        </ul>
      )}
      {editing && (
        <TriggerDialog projectId={projectId} initial={editing} onClose={() => setEditing(null)} />
      )}
      {running && (
        <RunFactoryFlowDialog
          open
          onOpenChange={setRunning}
          projects={[{ id: projectId, name: project?.name ?? projectId }]}
        />
      )}
    </>
  );
}
