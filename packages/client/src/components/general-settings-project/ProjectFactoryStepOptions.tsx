/**
 * What each agent step of the factory's flow runs with (openspec
 * factory-flow-step-options): Validate flow loads the flow exactly as a run
 * would and shows its problems, or its agent steps with their resolved
 * options, where a member picks a provider, model or effort per step. The
 * permission mode and the tool lists stay in the reviewed flow file.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useFactoryFlowValidation } from '@/data/factory/hooks';
import type {
  FactoryFlowAgentStep,
  FactoryFlowProblem,
  FactoryStepOverride,
  FactoryStepOverrides,
} from '@/lib/api/factory';
import { EFFORT_LEVELS, PROVIDER_MODELS, PROVIDERS } from '@/lib/providers';

import { ProjectSettingRow } from './setting-primitives';

/** The select value that means "no override: what the flow says". */
const FLOW_DEFAULT = '__flow__';

type OverrideField = keyof FactoryStepOverride;

/** The overrides without `stepId`'s entry. */
function withoutStep(overrides: FactoryStepOverrides, stepId: string): FactoryStepOverrides {
  const { [stepId]: _removed, ...rest } = overrides;
  return rest;
}

/**
 * The overrides with `field` of `stepId` set to `value` (or removed for
 * `null`). A provider change drops a model the new provider does not have,
 * and a step left with no field is removed.
 */
export function withStepOverride(
  overrides: FactoryStepOverrides,
  stepId: string,
  field: OverrideField,
  value: string | null,
): FactoryStepOverrides {
  const { [stepId]: current = {}, ...others } = overrides;
  const next: FactoryStepOverride = { ...current };
  if (value === null) delete next[field];
  else if (field === 'effort') next.effort = value as FactoryStepOverride['effort'];
  else next[field] = value;
  if (field === 'provider' && next.model && next.provider) {
    const models = PROVIDER_MODELS[next.provider] ?? [];
    if (!models.some((model) => model.value === next.model)) delete next.model;
  }
  return Object.keys(next).length === 0 ? others : { ...others, [stepId]: next };
}

function ProblemList({ problems }: { problems: FactoryFlowProblem[] }) {
  const { t } = useTranslation();
  return (
    <Alert
      variant="destructive"
      className="mx-4 my-2 w-auto"
      data-testid="settings-factory-problems"
    >
      <AlertDescription>
        <p className="font-medium">
          {t(
            'settings.projectFactoryFlowRefused',
            'A run of this flow would fail before it starts:',
          )}
        </p>
        <ul className="mt-1 list-disc pl-4">
          {problems.map((problem) => (
            <li key={`${problem.step}/${problem.field}`} data-testid="settings-factory-problem">
              <span className="font-mono">{problem.step}</span>
              {problem.field !== 'flow' && <span className="font-mono"> · {problem.field}</span>}
              {': '}
              {problem.message}
            </li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}

function OverrideSelect({
  value,
  options,
  onChange,
  testId,
  label,
}: {
  value: string | undefined;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string | null) => void;
  testId: string;
  label: string;
}) {
  const { t } = useTranslation();
  return (
    <Select
      value={value ?? FLOW_DEFAULT}
      onValueChange={(next) => onChange(next === FLOW_DEFAULT ? null : next)}
    >
      <SelectTrigger
        textSize="xs"
        className="h-7 w-[132px]"
        aria-label={label}
        data-testid={testId}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={FLOW_DEFAULT}>
          {t('settings.projectFactoryFlowDefault', 'From the flow')}
        </SelectItem>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function StepRow({
  step,
  override,
  onChange,
}: {
  step: FactoryFlowAgentStep;
  override: FactoryStepOverride | undefined;
  onChange: (field: OverrideField, value: string | null) => void;
}) {
  const { t } = useTranslation();
  const provider = override?.provider ?? step.provider;
  const models = (PROVIDER_MODELS[provider] ?? []).map((model) => ({
    value: model.value,
    label: model.fallback,
  }));
  const resolved = [step.provider, step.model, step.effort, step.permissionMode]
    .filter(Boolean)
    .join(' · ');
  return (
    <li
      className="border-border/50 flex flex-wrap items-center gap-2 border-t px-4 py-2 text-xs"
      data-testid={`settings-factory-step-${step.stepId}`}
    >
      <span className="min-w-[140px] font-mono">{step.stepId}</span>
      {step.thread === 'new' && (
        <Badge variant="outline" data-testid={`settings-factory-step-${step.stepId}-own-thread`}>
          {t('settings.projectFactoryOwnThread', 'Own read-only thread')}
        </Badge>
      )}
      <span
        className="text-muted-foreground flex-1"
        data-testid={`settings-factory-step-${step.stepId}-resolved`}
      >
        {resolved}
      </span>
      <OverrideSelect
        label={t('settings.projectFactoryProvider', 'Provider')}
        value={override?.provider}
        options={PROVIDERS.map((p) => ({ value: p.value, label: p.label }))}
        onChange={(value) => onChange('provider', value)}
        testId={`settings-factory-step-${step.stepId}-provider`}
      />
      <OverrideSelect
        label={t('settings.projectFactoryModel', 'Model')}
        value={override?.model}
        options={models}
        onChange={(value) => onChange('model', value)}
        testId={`settings-factory-step-${step.stepId}-model`}
      />
      <OverrideSelect
        label={t('settings.projectFactoryEffort', 'Effort')}
        value={override?.effort}
        options={EFFORT_LEVELS.map((e) => ({ value: e.value, label: e.label }))}
        onChange={(value) => onChange('effort', value)}
        testId={`settings-factory-step-${step.stepId}-effort`}
      />
    </li>
  );
}

export function ProjectFactoryStepOptions({
  projectId,
  flowName,
  overrides,
  onSave,
}: {
  projectId: string;
  flowName: string;
  overrides: FactoryStepOverrides;
  onSave: (stepOverrides: FactoryStepOverrides) => void;
}) {
  const { t } = useTranslation();
  const [requested, setRequested] = useState(false);
  const { validation, error, loading, refresh } = useFactoryFlowValidation(
    projectId,
    flowName,
    requested,
    overrides,
  );
  const validate = () => (requested ? refresh() : setRequested(true));
  const change = (stepId: string, field: OverrideField, value: string | null) =>
    onSave(withStepOverride(overrides, stepId, field, value));

  return (
    <>
      <ProjectSettingRow
        settingId="factory.stepOptions"
        title={t('settings.projectFactoryStepOptions', 'Agent steps')}
        description={t(
          'settings.projectFactoryStepOptionsDesc',
          'Check the flow as a run would load it, and pick a provider, model or effort per agent step',
        )}
      >
        <Button
          size="sm"
          variant="outline"
          disabled={loading}
          onClick={validate}
          data-testid="settings-factory-validate-flow"
        >
          {t('settings.projectFactoryValidateFlow', 'Validate flow')}
        </Button>
      </ProjectSettingRow>

      {error && (
        <Alert
          variant="destructive"
          className="mx-4 my-2 w-auto"
          data-testid="settings-factory-validation-error"
        >
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      )}

      {validation && !validation.ok && <ProblemList problems={validation.problems} />}

      {validation?.ok && (
        <div data-testid="settings-factory-step-summary">
          <p
            className="text-muted-foreground px-4 py-1 text-xs"
            data-testid="settings-factory-flow-source"
          >
            {validation.source === 'repository'
              ? t('settings.projectFactoryFlowFromRepo', 'Read from the repository at {{commit}}', {
                  commit: validation.commit?.slice(0, 7) ?? '?',
                })
              : t('settings.projectFactoryFlowBuiltIn', 'Built-in flow')}
          </p>
          {validation.warnings.map((warning) => (
            <Alert
              key={warning}
              className="mx-4 my-1 w-auto"
              data-testid="settings-factory-flow-warning"
            >
              <AlertDescription>{warning}</AlertDescription>
            </Alert>
          ))}
          <ul>
            {validation.agentSteps.map((step) => (
              <StepRow
                key={step.stepId}
                step={step}
                override={overrides[step.stepId]}
                onChange={(field, value) => change(step.stepId, field, value)}
              />
            ))}
            {validation.unusedOverrides.map((stepId) => (
              <li
                key={stepId}
                className="border-border/50 flex items-center gap-2 border-t px-4 py-2 text-xs"
                data-testid={`settings-factory-unused-${stepId}`}
              >
                <span className="min-w-[140px] font-mono">{stepId}</span>
                <span className="text-muted-foreground flex-1">
                  {t('settings.projectFactoryUnusedOverride', 'Not a step of this flow: unused')}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => onSave(withoutStep(overrides, stepId))}
                  data-testid={`settings-factory-unused-${stepId}-remove`}
                >
                  {t('common.remove', 'Remove')}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
