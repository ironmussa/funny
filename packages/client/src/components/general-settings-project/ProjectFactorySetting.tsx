import type { TFunction } from 'i18next';
/**
 * The issue factory for a project (change issue-factory): a per-user running /
 * paused toggle, the mode (manual: only the issues sent from the Issues tab;
 * automatic: also the issues carrying the label, change factory-manual-queue),
 * the default flow, and how many issues run at once.
 * Every contributor configures their own; a viewer sees theirs but a save is
 * refused (403) and shown as an error.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { saveFactorySettings, startFactoryFlowSetup } from '@/data/factory/actions';
import { useFactoryFlowValidation, useFactorySettings } from '@/data/factory/hooks';
import { useCanSteerProject } from '@/data/projects/hooks';
import type { FactoryMode, FactorySettings, SaveFactorySettingsInput } from '@/lib/api/factory';
import { toastError } from '@/lib/toast-error';

import { ProjectFactoryBaseBranch } from './ProjectFactoryBaseBranch';
import { ProjectFactoryFlowSetupCard } from './ProjectFactoryFlowSetupCard';
import { ProjectFactoryIncident } from './ProjectFactoryIncident';
import { ProjectFactoryLanes } from './ProjectFactoryLanes';
import { ProjectFactoryMergeRows } from './ProjectFactoryMergeRows';
import { ProjectFactorySpecRows } from './ProjectFactorySpecRows';
import { ProjectFactoryStepOptions } from './ProjectFactoryStepOptions';
import { ProjectFactoryTriggers } from './ProjectFactoryTriggers';
import { SegmentedControl, ProjectSettingRow } from './setting-primitives';

type OnOff = 'on' | 'off';

/** The settings the form edits. */
type FactoryForm = Pick<
  FactorySettings,
  | 'enabled'
  | 'mode'
  | 'label'
  | 'flowName'
  | 'maxConcurrent'
  | 'autoMerge'
  | 'sensitivePaths'
  | 'sizeGateEnabled'
  | 'maxLowRiskLines'
  | 'approvalAdjustMaxLines'
  | 'sizeIgnoredPaths'
  | 'stageLimits'
  | 'stepOverrides'
  | 'batch'
  | 'dependencies'
  | 'tooBig'
  | 'specStage'
  | 'commitSpecPath'
  | 'holdPathsAwaitingApproval'
  | 'baseBranch'
  | 'laneLabelPrefix'
  | 'laneBranchPrefix'
  | 'laneFinishBranch'
>;

/** The server's defaults: what the form shows before the first save. */
const DEFAULT_FORM: FactoryForm = {
  enabled: false,
  mode: 'manual',
  label: 'ready-for-agent',
  flowName: 'issue-to-merge',
  maxConcurrent: 2,
  autoMerge: 'low_risk',
  sensitivePaths: [],
  sizeGateEnabled: false,
  maxLowRiskLines: 400,
  approvalAdjustMaxLines: 0,
  sizeIgnoredPaths: [],
  stageLimits: {},
  stepOverrides: {},
  batch: { size: 5, waitSeconds: 60 },
  dependencies: 'wait',
  tooBig: 'ask',
  specStage: false,
  commitSpecPath: '',
  holdPathsAwaitingApproval: false,
  baseBranch: '',
  laneLabelPrefix: 'feature:',
  laneBranchPrefix: 'feature/',
  laneFinishBranch: '',
};

/** What the form shows: the saved settings, or the defaults before the first save. */
function formValues(settings: FactorySettings | null | undefined): FactoryForm {
  if (!settings) return DEFAULT_FORM;
  const { enabled, mode, label, flowName, maxConcurrent } = settings;
  const { autoMerge, sensitivePaths, stageLimits, stepOverrides, batch, dependencies } = settings;
  const { maxLowRiskLines, sizeIgnoredPaths, tooBig, approvalAdjustMaxLines } = settings;
  const { holdPathsAwaitingApproval, baseBranch, sizeGateEnabled } = settings;
  const { laneLabelPrefix, laneBranchPrefix, specStage, commitSpecPath } = settings;
  const { laneFinishBranch } = settings;
  return {
    enabled,
    mode,
    label,
    flowName,
    maxConcurrent,
    autoMerge,
    sensitivePaths,
    sizeGateEnabled,
    maxLowRiskLines,
    approvalAdjustMaxLines,
    sizeIgnoredPaths,
    stageLimits,
    stepOverrides,
    batch,
    dependencies,
    tooBig,
    specStage,
    commitSpecPath,
    holdPathsAwaitingApproval,
    baseBranch,
    laneLabelPrefix,
    laneBranchPrefix,
    laneFinishBranch,
  };
}

/** The trimmed text when it is non-empty and differs from `current`, else null (nothing to save). */
function changedText(value: string, current: string): string | null {
  const next = value.trim();
  return next && next !== current ? next : null;
}

/** A concurrency within 1–20 that differs from `current`, else null. */
function changedConcurrency(value: string, current: number): number | null {
  const next = Number.parseInt(value, 10);
  const inRange = Number.isFinite(next) && next >= 1 && next <= 20;
  return inRange && next !== current ? next : null;
}

/** The mode, and the label that automatic mode picks up. */
function FactoryModeRows({
  mode,
  label,
  labelKey,
  onMode,
  onLabel,
}: {
  mode: FactoryMode;
  label: string;
  labelKey: string;
  onMode: (mode: FactoryMode) => void;
  onLabel: (label: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <ProjectSettingRow
        settingId="factory.mode"
        title={t('settings.projectFactoryMode', 'Mode')}
        description={
          mode === 'automatic'
            ? t(
                'settings.projectFactoryModeAutomaticDesc',
                'Also picks up the issues carrying the label, after the ones you send',
              )
            : t('settings.projectFactoryModeManualDesc', 'Only the issues you send')
        }
      >
        <SegmentedControl<FactoryMode>
          value={mode}
          onChange={onMode}
          options={[
            {
              value: 'manual',
              label: t('settings.projectFactoryManual', 'Manual'),
              testId: 'settings-factory-mode-manual',
            },
            {
              value: 'automatic',
              label: t('settings.projectFactoryAutomatic', 'Automatic'),
              testId: 'settings-factory-mode-automatic',
            },
          ]}
        />
      </ProjectSettingRow>

      {mode === 'automatic' && (
        <ProjectSettingRow
          settingId="factory.label"
          title={t('settings.projectFactoryLabel', 'Issue label')}
          description={t(
            'settings.projectFactoryLabelDesc',
            'Issues with this label are picked up',
          )}
        >
          <Input
            key={labelKey}
            defaultValue={label}
            className="w-[220px]"
            data-testid="settings-factory-label"
            onBlur={(e) => onLabel(e.target.value)}
          />
        </ProjectSettingRow>
      )}
    </>
  );
}

type FactorySettingsRow = ReturnType<typeof useFactorySettings>;
type SaveFactory = (input: Omit<SaveFactorySettingsInput, 'projectId'>) => void;
type FlowValidationState = ReturnType<typeof useFactoryFlowValidation>;

/** Why the factory cannot be turned on with this flow, or null when it can. */
function enableBlockedReason(
  t: TFunction,
  flowName: string,
  { validation, error }: FlowValidationState,
): string | null {
  if (error) {
    return t(
      'settings.projectFactoryFlowNotChecked',
      'The flow "{{flow}}" could not be checked: {{message}}',
      { flow: flowName, message: error.message },
    );
  }
  if (!validation) return null;
  if (!validation.ok) return validation.message;
  if (validation.proofReady) return null;
  return t(
    'settings.projectFactoryFlowNotProofReady',
    'The flow "{{flow}}" has no regression proof rules. Generate or configure regression proof, or opt out, before enabling.',
    { flow: flowName },
  );
}

function FactoryAlert({ testId, children }: { testId: string; children: string }) {
  return (
    <Alert variant="destructive" className="mx-4 my-2 w-auto" data-testid={testId}>
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}

/** Running / paused, why it cannot run yet, and why the last save was refused. */
function FactoryStatusRows({
  enabled,
  blockedReason,
  saveError,
  onEnabled,
}: {
  enabled: boolean;
  blockedReason: string | null;
  saveError: string | null;
  onEnabled: (value: OnOff) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <ProjectSettingRow
        settingId="factory.status"
        title={t('settings.projectFactoryStatus', 'Status')}
        description={t(
          'settings.projectFactoryStatusDesc',
          'Running: takes the issues you send from the Issues tab. Paused: nothing new starts; queued issues wait',
        )}
      >
        <SegmentedControl<OnOff>
          value={enabled ? 'on' : 'off'}
          onChange={onEnabled}
          options={[
            {
              value: 'off',
              label: t('settings.projectFactoryPaused', 'Paused'),
              testId: 'settings-factory-off',
            },
            {
              value: 'on',
              label: t('settings.projectFactoryRunning', 'Running'),
              testId: 'settings-factory-on',
              disabled: !enabled && Boolean(blockedReason),
            },
          ]}
        />
      </ProjectSettingRow>
      {!enabled && blockedReason && (
        <FactoryAlert testId="settings-factory-flow-status">{blockedReason}</FactoryAlert>
      )}
      {saveError && <FactoryAlert testId="settings-factory-save-error">{saveError}</FactoryAlert>}
    </>
  );
}

function FactoryGenerateConfigRow({
  projectId,
  flowName,
}: {
  projectId: string;
  flowName: string;
}) {
  const { t } = useTranslation();
  return (
    <ProjectSettingRow
      settingId="factory.proofConfig"
      title={t('settings.projectFactoryProofConfig', 'Regression proof')}
      description={t(
        'settings.projectFactoryProofConfigDesc',
        'Generate verified regression proof rules for this flow from the repository stack',
      )}
    >
      <Button
        type="button"
        variant="outline"
        size="sm"
        data-testid="factory-generate-config"
        onClick={() => {
          void startFactoryFlowSetup(projectId, flowName).then((res) => {
            if (res.isErr()) toastError(res.error);
          });
        }}
      >
        {t('settings.projectFactoryGenerateConfig', 'Generate configuration')}
      </Button>
    </ProjectSettingRow>
  );
}

/** What a running factory lets a member tune: flow, concurrency, base branch, merge, spec, steps. */
function FactoryEnabledRows({
  projectId,
  form,
  rowKey,
  save,
}: {
  projectId: string;
  form: FactoryForm;
  rowKey: string;
  save: SaveFactory;
}) {
  const { t } = useTranslation();
  const { enabled, flowName, maxConcurrent } = form;
  const setFlow = (value: string) => {
    const next = changedText(value, flowName);
    if (next) save({ enabled, flowName: next });
  };
  const setConcurrency = (value: string) => {
    const next = changedConcurrency(value, maxConcurrent);
    if (next !== null) save({ enabled, maxConcurrent: next });
  };
  return (
    <>
      <ProjectSettingRow
        settingId="factory.flow"
        title={t('settings.projectFactoryFlow', 'Flow')}
        description={t(
          'settings.projectFactoryFlowDesc',
          'The default flow: preselected when you send issues, and run for labelled ones',
        )}
      >
        <Input
          key={`flow-${rowKey}`}
          defaultValue={flowName}
          className="w-[220px]"
          data-testid="settings-factory-flow"
          onBlur={(e) => setFlow(e.target.value)}
        />
      </ProjectSettingRow>

      <ProjectSettingRow
        settingId="factory.concurrency"
        title={t('settings.projectFactoryConcurrency', 'Max in flight')}
        description={t('settings.projectFactoryConcurrencyDesc', 'How many issues run at once')}
      >
        <Input
          key={`conc-${rowKey}`}
          type="number"
          min={1}
          max={20}
          defaultValue={maxConcurrent}
          className="w-[220px]"
          data-testid="settings-factory-concurrency"
          onBlur={(e) => setConcurrency(e.target.value)}
        />
      </ProjectSettingRow>

      <ProjectFactoryBaseBranch
        projectId={projectId}
        baseBranch={form.baseBranch}
        onSave={(baseBranch) => save({ enabled, baseBranch })}
      />

      <ProjectFactoryMergeRows
        projectId={projectId}
        flowName={flowName}
        settings={form}
        rowKey={rowKey}
        onSave={(input) => save({ enabled, ...input })}
      />

      <ProjectFactorySpecRows
        specStage={form.specStage}
        commitSpecPath={form.commitSpecPath}
        rowKey={rowKey}
        onSave={(input) => save({ enabled, ...input })}
      />

      <ProjectFactoryStepOptions
        projectId={projectId}
        flowName={flowName}
        overrides={form.stepOverrides}
        onSave={(stepOverrides) => save({ enabled, stepOverrides })}
      />
    </>
  );
}

/** Shown running or paused: schedules, lanes, the incident that pauses it, or another block. */
function FactoryOverviewRows({
  projectId,
  settings,
  form,
  rowKey,
  save,
}: {
  projectId: string;
  settings: NonNullable<FactorySettingsRow>;
  form: FactoryForm;
  rowKey: string;
  save: SaveFactory;
}) {
  return (
    <>
      {/* Listed while paused too: a paused factory keeps its schedules and starts none. */}
      <ProjectFactoryTriggers projectId={projectId} />
      <ProjectFactoryLanes
        projectId={projectId}
        label={form.label}
        laneLabelPrefix={form.laneLabelPrefix}
        laneBranchPrefix={form.laneBranchPrefix}
        laneFinishBranch={form.laneFinishBranch}
        rowKey={rowKey}
        onSave={(input) => save({ enabled: form.enabled, ...input })}
      />
      {settings.incident && (
        <ProjectFactoryIncident projectId={projectId} incident={settings.incident} />
      )}
      {/* An incident says why itself; any other reason is shown as the watcher wrote it. */}
      {settings.blockedReason && !settings.incident && (
        <FactoryAlert testId="settings-factory-blocked">{settings.blockedReason}</FactoryAlert>
      )}
    </>
  );
}

function ProjectFactorySettingRows({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const settings = useFactorySettings(projectId);
  // Bumped after every save settles, so the inputs re-read the confirmed row —
  // also after a refused save, which leaves the row (and its updatedAt) unchanged.
  const [revision, setRevision] = useState(0);
  const [saveError, setSaveError] = useState<string | null>(null);

  const saveNow = (input: Omit<SaveFactorySettingsInput, 'projectId'>) => {
    setSaveError(null);
    return saveFactorySettings({ projectId, ...input })
      .orTee((error) => {
        setSaveError(error.friendlyMessage ?? error.message);
        toastError(error, 'factory');
      })
      .match(
        () => setRevision((r) => r + 1),
        () => setRevision((r) => r + 1),
      );
  };
  const save: SaveFactory = (input) => void saveNow(input);

  const form = formValues(settings);
  const { enabled, mode, label, flowName } = form;
  const rowKey = `${settings?.updatedAt ?? 'none'}-${revision}`;
  const flowValidation = useFactoryFlowValidation(projectId, flowName, true, form.stepOverrides);
  const { validation } = flowValidation;

  const setLabel = (value: string) => {
    const next = changedText(value, label);
    if (next) save({ enabled, label: next });
  };

  return (
    <>
      <FactoryStatusRows
        enabled={enabled}
        blockedReason={enableBlockedReason(t, flowName, flowValidation)}
        saveError={saveError}
        onEnabled={(value) => save({ enabled: value === 'on' })}
      />
      {validation?.ok && !validation.proofReady && (
        <FactoryGenerateConfigRow projectId={projectId} flowName={flowName} />
      )}
      <ProjectFactoryFlowSetupCard projectId={projectId} flowName={flowName} />

      {/* The mode can change while paused, so switching to manual never lets labelled issues in. */}
      <FactoryModeRows
        mode={mode}
        label={label}
        labelKey={`label-${rowKey}`}
        onMode={(value) => save({ enabled, mode: value })}
        onLabel={setLabel}
      />

      {enabled && (
        <FactoryEnabledRows projectId={projectId} form={form} rowKey={rowKey} save={save} />
      )}
      {settings && (
        <FactoryOverviewRows
          projectId={projectId}
          settings={settings}
          form={form}
          rowKey={rowKey}
          save={save}
        />
      )}
    </>
  );
}

/**
 * The project's issue factory as its own settings section, apart from the
 * project's general options. Hidden from a viewer: the setting is per-user and
 * only matters to whoever may start threads.
 */
export function ProjectFactorySetting({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const canSteer = useCanSteerProject(projectId);
  if (!canSteer) return null;
  return (
    <section data-testid="settings-factory-section">
      <h3 className="text-muted-foreground px-1 pb-1 text-xs font-semibold tracking-wider uppercase">
        {t('settings.projectFactory', 'Issue factory')}
      </h3>
      <p className="text-muted-foreground px-1 pb-2 text-xs">
        {t(
          'settings.projectFactoryDesc',
          'Runs a flow up to a pull request for each issue: the ones you send from the Issues tab, and in automatic mode the ones with its label. Your own; each member has theirs.',
        )}
      </p>
      <div className="border-border/50 mb-6 overflow-hidden rounded-lg border">
        <ProjectFactorySettingRows projectId={projectId} />
      </div>
    </section>
  );
}
