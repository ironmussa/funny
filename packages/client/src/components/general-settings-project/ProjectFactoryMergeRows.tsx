/**
 * How the caller's issue factory reviews and merges (change
 * factory-agent-roles): which reviewed changes it merges by itself, the paths
 * that always need a person, how large a low-risk change may be, how many runs may be in a stage at once, and the
 * merge queue's batches (openspec factory-integration). One batch merges at a
 * time per repository; that is not a setting.
 */
import { APPROVAL_ADJUST_LINES_RANGE, LOW_RISK_LINES_RANGE } from '@funny/shared/contracts/factory';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { proposeQueueCi } from '@/data/factory/actions';
import { useFactoryFlowDefinition, useFactoryReadiness } from '@/data/factory/hooks';
import type { FactorySettings, SaveFactorySettingsInput } from '@/lib/api/factory';
import { formatActionDuration } from '@/lib/github-actions';
import { toastError } from '@/lib/toast-error';

import { SegmentedControl, ProjectSettingRow } from './setting-primitives';

type AutoMerge = FactorySettings['autoMerge'];
type MergeSettings = Pick<
  FactorySettings,
  | 'autoMerge'
  | 'sensitivePaths'
  | 'sizeGateEnabled'
  | 'maxLowRiskLines'
  | 'approvalAdjustMaxLines'
  | 'sizeIgnoredPaths'
  | 'stageLimits'
  | 'batch'
  | 'dependencies'
  | 'tooBig'
  | 'holdPathsAwaitingApproval'
>;

const { min: LOW_RISK_LINES_MIN, max: LOW_RISK_LINES_MAX } = LOW_RISK_LINES_RANGE;
const { min: ADJUST_LINES_MIN, max: ADJUST_LINES_MAX } = APPROVAL_ADJUST_LINES_RANGE;
type BatchSettings = FactorySettings['batch'];
type Dependencies = FactorySettings['dependencies'];
type TooBig = FactorySettings['tooBig'];

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

/** Open the issue that adds CI on the queue's branches, run by the factory (D12). */
function ProposeQueueCi({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const propose = () => {
    setBusy(true);
    void proposeQueueCi(projectId)
      .map((proposal) => {
        if (proposal.queued) {
          toast.success(
            t(
              'settings.projectFactoryQueueCiQueued',
              'Issue #{{number}} opened and sent to the factory',
              {
                number: proposal.issueNumber,
              },
            ),
          );
        } else {
          toast.warning(
            t(
              'settings.projectFactoryQueueCiNotQueued',
              'Issue #{{number}} opened, but not sent to the factory: {{reason}}',
              {
                number: proposal.issueNumber,
                reason: proposal.reason ?? '',
              },
            ),
          );
        }
      })
      .orTee((error) => toastError(error, 'factory'))
      .match(
        () => setBusy(false),
        () => setBusy(false),
      );
  };
  return (
    <Button
      size="xs"
      variant="outline"
      className="mt-2"
      disabled={busy}
      onClick={propose}
      data-testid="settings-factory-propose-queue-ci"
    >
      {t('settings.projectFactoryQueueCiPropose', 'Open a factory run that adds the CI trigger')}
    </Button>
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
  const drivers: Record<'weave' | 'git' | 'unknown', string> = {
    weave: t('settings.projectFactoryMergeDriverWeave', 'weave'),
    git: t('settings.projectFactoryMergeDriverGit', "git's own"),
    unknown: t('settings.projectFactoryMergeDriverUnknown', 'known after the first integration'),
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
        <p className="mt-1" data-testid="settings-factory-readiness-driver">
          {t('settings.projectFactoryMergeDriver', 'Merge driver on the runner: {{driver}}', {
            driver: drivers[readiness.mergeDriver ?? 'unknown'],
          })}
        </p>
        {readiness.medianCiMs !== null && (
          <p data-testid="settings-factory-readiness-ci-time">
            {t(
              'settings.projectFactoryQueueCiTime',
              'CI on a batch takes {{ci}} (median); the batch wait is {{wait}}',
              {
                ci: formatActionDuration(readiness.medianCiMs),
                wait: formatActionDuration(readiness.batchWaitMs),
              },
            )}
          </p>
        )}
        {readiness.advice.length > 0 && (
          <ul className="mt-1 list-disc pl-4" data-testid="settings-factory-readiness-advice">
            {readiness.advice.map((advice) => (
              <li key={advice}>{advice}</li>
            ))}
          </ul>
        )}
        {readiness.queueCi === false && <ProposeQueueCi projectId={projectId} />}
      </AlertDescription>
    </Alert>
  );
}

/** The size gate and the adjustment an approval follows (change factory-agent-roles). */
function SizeRows({
  settings,
  rowKey,
  onSave,
}: {
  settings: Pick<
    MergeSettings,
    'sizeGateEnabled' | 'maxLowRiskLines' | 'sizeIgnoredPaths' | 'approvalAdjustMaxLines'
  >;
  rowKey: string;
  onSave: (input: Pick<SaveFactorySettingsInput, keyof MergeSettings>) => void;
}) {
  const { t } = useTranslation();
  const { sizeGateEnabled, maxLowRiskLines, sizeIgnoredPaths, approvalAdjustMaxLines } = settings;
  return (
    <>
      <ProjectSettingRow
        settingId="factory.sizeGateEnabled"
        title={t('settings.projectFactorySizeGate', 'Size gate')}
        description={t(
          'settings.projectFactorySizeGateDesc',
          'A change with more changed lines than a limit you set is high risk. Off: the size of a change does not make it high risk',
        )}
      >
        <Switch
          checked={sizeGateEnabled}
          onCheckedChange={(checked) => onSave({ sizeGateEnabled: checked })}
          data-testid="settings-factory-size-gate"
        />
      </ProjectSettingRow>

      {sizeGateEnabled && (
        <ProjectSettingRow
          settingId="factory.maxLowRiskLines"
          title={t('settings.projectFactoryMaxLowRiskLines', 'Size of a low-risk change')}
          description={t(
            'settings.projectFactoryMaxLowRiskLinesDesc',
            'A change with more changed lines than this is high risk. Tests, Markdown, translations, stories, snapshots and lockfiles do not count',
          )}
        >
          <Input
            key={`max-lines-${rowKey}`}
            type="number"
            min={LOW_RISK_LINES_MIN}
            max={LOW_RISK_LINES_MAX}
            defaultValue={maxLowRiskLines}
            className="w-[96px]"
            data-testid="settings-factory-max-low-risk-lines"
            onBlur={(e) => {
              const next = wholeNumber(e.target.value, LOW_RISK_LINES_MIN, LOW_RISK_LINES_MAX);
              if (next !== null && next !== maxLowRiskLines) onSave({ maxLowRiskLines: next });
            }}
          />
        </ProjectSettingRow>
      )}

      <ProjectSettingRow
        settingId="factory.sizeIgnoredPaths"
        title={t('settings.projectFactorySizeIgnoredPaths', 'Not counted in size')}
        description={t(
          'settings.projectFactorySizeIgnoredPathsDesc',
          'Globs, separated by commas. Their lines do not count toward the size of a change. Sensitive paths still apply to them',
        )}
      >
        <Input
          key={`size-ignored-${rowKey}`}
          defaultValue={sizeIgnoredPaths.join(', ')}
          placeholder="**/generated/**, *.json"
          className="w-[220px]"
          data-testid="settings-factory-size-ignored-paths"
          onBlur={(e) => {
            const next = parsePathList(e.target.value);
            if (next.join('\n') !== sizeIgnoredPaths.join('\n')) onSave({ sizeIgnoredPaths: next });
          }}
        />
      </ProjectSettingRow>

      <ProjectSettingRow
        settingId="factory.approvalAdjustMaxLines"
        title={t('settings.projectFactoryApprovalAdjust', 'Adjustment an approval follows')}
        description={t(
          'settings.projectFactoryApprovalAdjustDesc',
          'After you approve a high-risk change, the factory may merge a later commit that differs from it by at most this many lines, only in files you approved and with no new risk reason. It then merges lines no person read; the review still has to pass. 0: only the same change',
        )}
      >
        <Input
          key={`approval-adjust-${rowKey}`}
          type="number"
          min={ADJUST_LINES_MIN}
          max={ADJUST_LINES_MAX}
          defaultValue={approvalAdjustMaxLines}
          className="w-[96px]"
          data-testid="settings-factory-approval-adjust-max-lines"
          onBlur={(e) => {
            const next = wholeNumber(
              e.target.value.trim() || 'x',
              ADJUST_LINES_MIN,
              ADJUST_LINES_MAX,
            );
            if (next !== null && next !== approvalAdjustMaxLines) {
              onSave({ approvalAdjustMaxLines: next });
            }
          }}
        />
      </ProjectSettingRow>
    </>
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
  const { tooBig, holdPathsAwaitingApproval } = settings;

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

      <SizeRows settings={settings} rowKey={rowKey} onSave={onSave} />

      <ProjectSettingRow
        settingId="factory.holdPathsAwaitingApproval"
        title={t('settings.projectFactoryHoldPaths', 'Keep files while waiting for an approval')}
        description={t(
          'settings.projectFactoryHoldPathsDesc',
          'While a high-risk change waits for your approval, no other run starts on the files it is expected to touch, for at most 12 hours. Later runs wait longer; approved changes meet fewer conflicts',
        )}
      >
        <Switch
          checked={holdPathsAwaitingApproval}
          onCheckedChange={(checked) => onSave({ holdPathsAwaitingApproval: checked })}
          data-testid="settings-factory-hold-paths-awaiting-approval"
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

      <ProjectSettingRow
        settingId="factory.tooBig"
        title={t('settings.projectFactoryTooBig', 'Issues too large for one change')}
        description={
          tooBig === 'split'
            ? t(
                'settings.projectFactoryTooBigSplitDesc',
                'The factory opens each part triage proposes as its own issue and works on them; the original issue leaves the factory. A part is never split again by itself',
              )
            : t(
                'settings.projectFactoryTooBigAskDesc',
                'The factory comments the split triage proposes on the issue, and waits until a person changes the issue',
              )
        }
      >
        <SegmentedControl<TooBig>
          value={tooBig}
          onChange={(value) => onSave({ tooBig: value })}
          options={[
            {
              value: 'ask',
              label: t('settings.projectFactoryTooBigAsk', 'Ask'),
              testId: 'settings-factory-too-big-ask',
            },
            {
              value: 'split',
              label: t('settings.projectFactoryTooBigSplit', 'Split'),
              testId: 'settings-factory-too-big-split',
            },
          ]}
        />
      </ProjectSettingRow>
    </>
  );
}
