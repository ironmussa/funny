/**
 * How the caller's issue factory reviews and merges (change
 * factory-agent-roles): which reviewed changes it merges by itself, the paths
 * that always need a person, how many runs may be in a stage at once, and the
 * merge queue's batches (openspec factory-integration). One batch merges at a
 * time per repository; that is not a setting.
 */
import { useTranslation } from 'react-i18next';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Input } from '@/components/ui/input';
import { useFactoryFlowDefinition, useFactoryReadiness } from '@/data/factory/hooks';
import type { FactorySettings, SaveFactorySettingsInput } from '@/lib/api/factory';

import { SegmentedControl, ProjectSettingRow } from './setting-primitives';

type AutoMerge = FactorySettings['autoMerge'];
type MergeSettings = Pick<
  FactorySettings,
  'autoMerge' | 'sensitivePaths' | 'stageLimits' | 'batch' | 'dependencies'
>;
type BatchSettings = FactorySettings['batch'];
type Dependencies = FactorySettings['dependencies'];

/** The input's whole number within `min`–`max`, or null when it is not one. */
function wholeNumber(text: string, min: number, max: number): number | null {
  const value = Number(text);
  return Number.isInteger(value) && value >= min && value <= max ? value : null;
}

/** The merge queue's batch size and wait (openspec factory-integration D2). */
function BatchInputs({
  batch,
  inputKey,
  onSave,
}: {
  batch: BatchSettings;
  inputKey: string;
  onSave: (batch: BatchSettings) => void;
}) {
  const { t } = useTranslation();
  const save = (field: keyof BatchSettings, text: string, max: number) => {
    const value = wholeNumber(text, field === 'size' ? 1 : 0, max);
    if (value !== null && value !== batch[field]) onSave({ ...batch, [field]: value });
  };
  return (
    <div className="flex items-center gap-3">
      <label className="text-muted-foreground flex items-center gap-2 text-xs">
        {t('settings.projectFactoryBatchSize', 'Pull requests')}
        <Input
          key={`size-${inputKey}`}
          type="number"
          min={1}
          max={10}
          defaultValue={batch.size}
          className="w-[72px]"
          data-testid="settings-factory-batch-size"
          onBlur={(e) => save('size', e.target.value, 10)}
        />
      </label>
      <label className="text-muted-foreground flex items-center gap-2 text-xs">
        {t('settings.projectFactoryBatchWait', 'Wait (s)')}
        <Input
          key={`wait-${inputKey}`}
          type="number"
          min={0}
          max={600}
          defaultValue={batch.waitSeconds}
          className="w-[80px]"
          data-testid="settings-factory-batch-wait"
          onBlur={(e) => save('waitSeconds', e.target.value, 600)}
        />
      </label>
    </div>
  );
}

/** The stages a factory can limit. `merge` is absent on purpose: it is always one at a time. */
const LIMITED_STAGES = ['implement', 'review'] as const;
type LimitedStage = (typeof LIMITED_STAGES)[number];

/** The globs of a comma- or newline-separated list, trimmed, without empties or repeats. */
function parsePathList(text: string): string[] {
  const paths = text
    .split(/[,\n]/)
    .map((path) => path.trim())
    .filter(Boolean);
  return [...new Set(paths)];
}

/**
 * The limits with `stage` set from the input's text: a number within 1–20
 * sets it, an empty input removes it (the flow's own limit applies again).
 * Null when the text is neither, or changes nothing.
 */
function withStageLimit(
  limits: Record<string, number>,
  stage: string,
  text: string,
): Record<string, number> | null {
  const { [stage]: current, ...others } = limits;
  if (text.trim() === '') return current === undefined ? null : others;
  const next = Number.parseInt(text, 10);
  if (!Number.isFinite(next) || next < 1 || next > 20 || next === current) return null;
  return { ...others, [stage]: next };
}

function StageLimitInput({
  stage,
  limits,
  inputKey,
  onSave,
}: {
  stage: LimitedStage;
  limits: Record<string, number>;
  inputKey: string;
  onSave: (limits: Record<string, number>) => void;
}) {
  const { t } = useTranslation();
  const labels: Record<LimitedStage, string> = {
    implement: t('settings.projectFactoryLimitImplement', 'Implementing'),
    review: t('settings.projectFactoryLimitReview', 'Reviewing'),
  };
  return (
    <label className="text-muted-foreground flex items-center gap-2 text-xs">
      {labels[stage]}
      <Input
        key={inputKey}
        type="number"
        min={1}
        max={20}
        defaultValue={limits[stage] ?? ''}
        placeholder={t('settings.projectFactoryLimitNone', 'No limit')}
        className="w-[96px]"
        data-testid={`settings-factory-limit-${stage}`}
        onBlur={(e) => {
          const next = withStageLimit(limits, stage, e.target.value);
          if (next) onSave(next);
        }}
      />
    </label>
  );
}

/** How this repository merges now, and what to change for batches (D12). */
function QueueReadiness({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const readiness = useFactoryReadiness(projectId);
  if (!readiness) return null;
  const modes: Record<typeof readiness.mode, string> = {
    batches: t('settings.projectFactoryReadinessBatches', 'Ready pull requests merge in batches.'),
    serial: t('settings.projectFactoryReadinessSerial', 'Pull requests merge one at a time:'),
    'host-queue': t(
      'settings.projectFactoryReadinessHostQueue',
      "Pull requests merge through GitHub's merge queue:",
    ),
  };
  return (
    <Alert className="mx-4 my-2 w-auto" data-testid="settings-factory-readiness">
      <AlertDescription>
        <p data-testid="settings-factory-readiness-mode">{modes[readiness.mode]}</p>
        {readiness.reasons.length > 0 && (
          <ul className="mt-1 list-disc pl-4">
            {readiness.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        )}
      </AlertDescription>
    </Alert>
  );
}

export function ProjectFactoryMergeRows({
  projectId,
  flowName,
  settings,
  rowKey,
  onSave,
}: {
  projectId: string;
  flowName: string;
  settings: MergeSettings;
  /** Changes after every save, so the inputs re-read the confirmed values. */
  rowKey: string;
  onSave: (input: Pick<SaveFactorySettingsInput, keyof MergeSettings>) => void;
}) {
  const { t } = useTranslation();
  const { definition } = useFactoryFlowDefinition(projectId, flowName);
  const { autoMerge, sensitivePaths, stageLimits, batch, dependencies } = settings;

  return (
    <>
      {definition?.reviewerSameAsImplementer && (
        <Alert className="mx-4 my-2 w-auto" data-testid="settings-factory-same-reviewer">
          <AlertDescription>
            {t(
              'settings.projectFactorySameReviewer',
              'The review step of this flow uses the same provider and model as the implementing agent, so it tends to miss what the implementer missed. Set a different provider or model on the review step of the flow.',
            )}
          </AlertDescription>
        </Alert>
      )}

      <ProjectSettingRow
        settingId="factory.autoMerge"
        title={t('settings.projectFactoryAutoMerge', 'Merges by itself')}
        description={
          autoMerge === 'all'
            ? t(
                'settings.projectFactoryAutoMergeAllDesc',
                'Every change that passed its review, also high-risk ones',
              )
            : t(
                'settings.projectFactoryAutoMergeLowDesc',
                'Only low-risk changes that passed their review. A high-risk change waits for you',
              )
        }
      >
        <SegmentedControl<AutoMerge>
          value={autoMerge}
          onChange={(value) => onSave({ autoMerge: value })}
          options={[
            {
              value: 'low_risk',
              label: t('settings.projectFactoryAutoMergeLow', 'Low risk'),
              testId: 'settings-factory-automerge-low',
            },
            {
              value: 'all',
              label: t('settings.projectFactoryAutoMergeAll', 'All'),
              testId: 'settings-factory-automerge-all',
            },
          ]}
        />
      </ProjectSettingRow>

      <ProjectSettingRow
        settingId="factory.sensitivePaths"
        title={t('settings.projectFactorySensitivePaths', 'Sensitive paths')}
        description={t(
          'settings.projectFactorySensitivePathsDesc',
          'Globs, separated by commas. A change that touches one is high risk, besides .github/, migrations and auth/',
        )}
      >
        <Input
          key={`paths-${rowKey}`}
          defaultValue={sensitivePaths.join(', ')}
          placeholder="billing/**, infra/**"
          className="w-[220px]"
          data-testid="settings-factory-sensitive-paths"
          onBlur={(e) => {
            const next = parsePathList(e.target.value);
            if (next.join('\n') !== sensitivePaths.join('\n')) onSave({ sensitivePaths: next });
          }}
        />
      </ProjectSettingRow>

      <ProjectSettingRow
        settingId="factory.stageLimits"
        title={t('settings.projectFactoryStageLimits', 'Runs per step')}
        description={t(
          'settings.projectFactoryStageLimitsDesc',
          'How many runs may be implementing or in review at once. Merges are always one batch at a time per repository',
        )}
      >
        <div className="flex items-center gap-3">
          {LIMITED_STAGES.map((stage) => (
            <StageLimitInput
              key={stage}
              stage={stage}
              limits={stageLimits}
              inputKey={`limit-${stage}-${rowKey}`}
              onSave={(next) => onSave({ stageLimits: next })}
            />
          ))}
        </div>
      </ProjectSettingRow>

      <ProjectSettingRow
        settingId="factory.batch"
        title={t('settings.projectFactoryBatch', 'Merge queue')}
        description={t(
          'settings.projectFactoryBatchDesc',
          'Ready pull requests are tested together on the current base and merged as tested, in about one CI run. How many in one batch (1: one at a time), and how long to wait to gather them',
        )}
      >
        <BatchInputs batch={batch} inputKey={rowKey} onSave={(next) => onSave({ batch: next })} />
      </ProjectSettingRow>
      <QueueReadiness projectId={projectId} />

      <ProjectSettingRow
        settingId="factory.dependencies"
        title={t('settings.projectFactoryDependencies', 'Blockers in progress')}
        description={
          dependencies === 'stack'
            ? t(
                'settings.projectFactoryDependenciesStackDesc',
                "An issue whose blocker has a pull request open starts on the blocker's branch, and merges after it",
              )
            : t(
                'settings.projectFactoryDependenciesWaitDesc',
                'An issue waits until its blockers have merged',
              )
        }
      >
        <SegmentedControl<Dependencies>
          value={dependencies}
          onChange={(value) => onSave({ dependencies: value })}
          options={[
            {
              value: 'wait',
              label: t('settings.projectFactoryDependenciesWait', 'Wait'),
              testId: 'settings-factory-dependencies-wait',
            },
            {
              value: 'stack',
              label: t('settings.projectFactoryDependenciesStack', 'Stack'),
              testId: 'settings-factory-dependencies-stack',
            },
          ]}
        />
      </ProjectSettingRow>
    </>
  );
}
