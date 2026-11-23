/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: domain-service
 * @domain layer: domain
 *
 * The agent options one factory agent step runs with (openspec
 * factory-flow-step-options, D1): one pure rule, used by runs and by Validate
 * flow alike.
 *
 * Precedence, per field: the factory's step override (provider / model / effort
 * only), the step's own options, the flow's `defaults:`, then the project's
 * defaults and the factory's (`DEFAULT_PROVIDER`, the provider's default model,
 * `autoEdit`). Every field that a thread keeps between messages (provider,
 * model, permission mode) is always explicit, so a later step never runs on
 * what an earlier step set.
 */

import type { AgentProvider, EffortLevel, PermissionMode } from '@funny/shared';
import {
  DEFAULT_PROVIDER,
  getDefaultModel,
  MODEL_REGISTRY,
  providerModelProblem,
} from '@funny/shared/models';
import type { SpawnAgentDefaults, SpawnAgentOpts } from '@funny/workflows/compiler';

/** What a member may set per step from the factory settings. */
export interface StepOverride {
  provider?: string;
  model?: string;
  effort?: EffortLevel;
}

/** Step overrides by step id (`<node>`, `<node>.before_retry`). */
export type StepOverrides = Record<string, StepOverride>;

/** The project's own agent defaults, as its row stores them. */
export interface ProjectAgentDefaults {
  provider?: string | null;
  model?: string | null;
  effort?: string | null;
}

/** The options a step runs with, every field decided. */
export interface ResolvedStepOptions {
  stepId: string;
  provider: string;
  model: string;
  /** Null: the provider's own default effort. */
  effort: EffortLevel | null;
  permissionMode: PermissionMode;
  /** Null: no allow-list. */
  allowedTools: string[] | null;
  /** Null: no deny-list. */
  disallowedTools: string[] | null;
  thread: 'continue' | 'new';
}

/** A step's own options, as the compiler hands them to the provider. */
export type StepAgentOptions = Pick<
  SpawnAgentOpts,
  'provider' | 'model' | 'effort' | 'mode' | 'allowedTools' | 'disallowedTools' | 'thread'
>;

export interface ResolveStepOptionsInput {
  stepId: string;
  step: StepAgentOptions;
  flowDefaults?: SpawnAgentDefaults;
  overrides?: StepOverrides;
  project?: ProjectAgentDefaults;
}

const EFFORTS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const PERMISSION_MODES: readonly PermissionMode[] = [
  'plan',
  'auto',
  'autoEdit',
  'confirmEdit',
  'ask',
];

/** The factory's own permission mode: edits without asking, as an unattended run needs. */
export const FACTORY_PERMISSION_MODE: PermissionMode = 'autoEdit';

const effortOf = (value: string | null | undefined): EffortLevel | undefined =>
  EFFORTS.find((effort) => effort === value);

const firstDefined = <T>(...values: Array<T | null | undefined>): T | undefined =>
  values.find((value): value is T => value !== undefined && value !== null);

/** The provider's default model; a provider outside the registry has none here. */
function defaultModelOf(provider: string): string {
  const known = provider in MODEL_REGISTRY ? (provider as AgentProvider) : DEFAULT_PROVIDER;
  return getDefaultModel(known);
}

/**
 * The step's options with every precedence level applied. The model is the
 * first one, in precedence order, that runs on the resolved provider, so an
 * override that only changes the provider does not inherit a model of another
 * provider; with none, the provider's default model.
 */
export function resolveStepOptions(input: ResolveStepOptionsInput): ResolvedStepOptions {
  const { stepId, step, flowDefaults: d, project } = input;
  const override = input.overrides?.[stepId] ?? {};

  const provider =
    firstDefined(override.provider, step.provider, d?.provider, project?.provider) ??
    DEFAULT_PROVIDER;
  const models = [override.model, step.model, d?.model, project?.model].filter(
    (model): model is string => !!model,
  );
  const model =
    models.find((candidate) => providerModelProblem(provider, candidate) === null) ??
    defaultModelOf(provider);

  const effort =
    firstDefined(override.effort, step.effort, effortOf(d?.effort), effortOf(project?.effort)) ??
    null;
  const permissionMode =
    firstDefined(
      step.mode,
      PERMISSION_MODES.find((mode) => mode === d?.permissionMode),
    ) ?? FACTORY_PERMISSION_MODE;

  return {
    stepId,
    provider,
    model,
    effort,
    permissionMode,
    allowedTools: firstDefined(step.allowedTools, d?.allowedTools) ?? null,
    disallowedTools: firstDefined(step.disallowedTools, d?.disallowedTools) ?? null,
    thread: step.thread ?? 'continue',
  };
}
