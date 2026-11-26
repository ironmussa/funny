/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: domain-service
 * @domain layer: domain
 *
 * What a factory flow may say about its agent steps (openspec
 * factory-flow-step-options, D2). The workflow schema is generic; this pass
 * refuses whatever the server factory would not apply, so no option written in
 * a flow is ever dropped without a word. Every problem is reported at once,
 * each naming its step and field, for the run failure and for Validate flow.
 */

import type { FactoryFlowAgentStep, FactoryFlowProblem } from '@funny/shared/contracts/factory';
import {
  KNOWN_PROVIDER_IDS,
  providerModelProblem,
  READ_ONLY_PROVIDERS,
} from '@funny/shared/models';
import {
  getWorkflowNodeAction,
  listAgentSteps,
  type FlowAgentStep,
  type ParsedWorkflow,
} from '@funny/workflows';

import {
  resolveStepOptions,
  type ProjectAgentDefaults,
  type ResolvedStepOptions,
  type StepOverrides,
} from './factory-step-options.js';

/** One reason a flow cannot run as a factory flow (the contract's shape). */
export type { FactoryFlowProblem };

/**
 * Providers whose agent process applies `allowed_tools` / `denied_tools`
 * (`core/agents/sdk-claude.ts`, `core/agents/pi-sdk.ts`). Another provider
 * would run with the whole tool surface, so a tool list on it is refused. A
 * test fails if a listed provider's process stops reading `disallowedTools`.
 */
export const TOOL_POLICY_PROVIDERS: ReadonlySet<string> = new Set(['claude', 'pi']);

/** The agent-step fields the factory applies; any other one is refused. */
const APPLIED_FIELDS = new Set([
  'prompt',
  'prompt_file',
  'provider',
  'model',
  'effort',
  'permission_mode',
  'allowed_tools',
  'denied_tools',
  'thread',
]);

/** Permission modes that run unattended: edits without asking, or read-only. */
const UNATTENDED_MODES = new Set(['autoEdit', 'plan']);

const modeProblem = (mode: string) =>
  `permission_mode "${mode}" cannot run unattended: a factory step uses autoEdit or plan (ask and confirmEdit wait for a person, auto approves every tool)`;

/** Every node `id` depends on, directly or not. */
function ancestorsOf(id: string, depsOf: Map<string, string[]>): Set<string> {
  const seen = new Set<string>();
  const stack = [...(depsOf.get(id) ?? [])];
  for (let dep = stack.pop(); dep !== undefined; dep = stack.pop()) {
    if (seen.has(dep)) continue;
    seen.add(dep);
    stack.push(...(depsOf.get(dep) ?? []));
  }
  return seen;
}

/**
 * The node whose agent step runs first: the one no other agent node precedes.
 * The factory runs its agent steps one after the other (`agentStepIssues`), so
 * there is one.
 */
function firstAgentNode(parsed: ParsedWorkflow, steps: FlowAgentStep[]): string | undefined {
  const depsOf = new Map(parsed.nodes.map((node) => [node.id, node.depends_on]));
  const agentNodes = new Set(steps.map((step) => step.nodeId));
  return steps.find(
    (step) =>
      step.step === step.nodeId &&
      ![...ancestorsOf(step.nodeId, depsOf)].some((id) => agentNodes.has(id)),
  )?.nodeId;
}

function defaultsProblems(parsed: ParsedWorkflow): FactoryFlowProblem[] {
  const mode = parsed.defaults?.permission_mode;
  if (mode === undefined || UNATTENDED_MODES.has(mode)) return [];
  return [{ step: 'defaults', field: 'permission_mode', message: modeProblem(mode) }];
}

/** A problem of a step before its step id is attached. */
type StepProblem = Omit<FactoryFlowProblem, 'step'>;

/** What the step itself writes that the factory would not apply. */
function writtenProblems(action: FlowAgentStep['action'], parsed: ParsedWorkflow): StepProblem[] {
  const problems: StepProblem[] = Object.keys(action)
    .filter((field) => !APPLIED_FIELDS.has(field))
    .map((field) => ({ field, message: `${field} is not applied by the issue factory` }));
  if (action.permission_mode && !UNATTENDED_MODES.has(action.permission_mode)) {
    problems.push({ field: 'permission_mode', message: modeProblem(action.permission_mode) });
  }
  if (action.provider && !KNOWN_PROVIDER_IDS.includes(action.provider)) {
    problems.push({ field: 'provider', message: `Unknown provider "${action.provider}"` });
  }
  const defaults = parsed.defaults;
  const pairProblem = providerModelProblem(
    action.provider ?? defaults?.provider,
    action.model ?? (action.provider ? undefined : defaults?.model),
  );
  if (pairProblem) problems.push({ field: 'model', message: pairProblem });
  return problems;
}

/** Tool lists on a provider whose agent process would not apply them. */
function toolProblems(resolved: ResolvedStepOptions): StepProblem[] {
  if (TOOL_POLICY_PROVIDERS.has(resolved.provider)) return [];
  const lists = [
    ['allowed_tools', resolved.allowedTools],
    ['denied_tools', resolved.disallowedTools],
  ] as const;
  return lists.flatMap(([field, list]) =>
    list === null
      ? []
      : [
          {
            field,
            message: `${field} cannot be applied on provider "${resolved.provider}": only ${[...TOOL_POLICY_PROVIDERS].join(' and ')} apply tool lists`,
          },
        ],
  );
}

/** A `thread: new` step must be read-only, on a provider held to it, and not the first. */
function newThreadProblems(resolved: ResolvedStepOptions, isFirst: boolean): StepProblem[] {
  if (resolved.thread !== 'new') return [];
  const problems: StepProblem[] = [];
  if (resolved.permissionMode !== 'plan') {
    problems.push({
      field: 'thread',
      message:
        'thread: new runs beside the implementing thread, so it must be read-only (permission_mode: plan): only the implementing thread writes to the branch',
    });
  }
  if (!READ_ONLY_PROVIDERS.includes(resolved.provider)) {
    problems.push({
      field: 'provider',
      message: `thread: new runs read-only, which only ${READ_ONLY_PROVIDERS.join(' and ')} can be held to; "${resolved.provider}" cannot`,
    });
  }
  if (isFirst) {
    problems.push({
      field: 'thread',
      message:
        'thread: new cannot be on the first agent step: it is the implementing thread the later steps continue',
    });
  }
  return problems;
}

/** The problems of one agent step, its options resolved as a run would. */
function stepProblems(
  { step, action }: FlowAgentStep,
  parsed: ParsedWorkflow,
  firstNode: string | undefined,
  context: { overrides?: StepOverrides; project?: ProjectAgentDefaults },
): FactoryFlowProblem[] {
  const resolved = resolveStepOptions({
    stepId: step,
    step: stepInput(action),
    flowDefaults: defaultsInput(parsed),
    overrides: context.overrides,
    project: context.project,
  });
  return [
    ...writtenProblems(action, parsed),
    ...toolProblems(resolved),
    ...newThreadProblems(resolved, step === firstNode),
  ].map((problem) => ({ step, ...problem }));
}

/** A step timeout the runner accepts: at most an hour. */
const MAX_STEP_TIMEOUT_MS = 3_600_000;

/**
 * The problems of the flow's commands (`run_command` / `bash`). They run from
 * the root of the run's checkout on the runner, so `cwd` is refused (write
 * `cd dir && …`), and their timeout is at most an hour.
 */
function commandProblems(parsed: ParsedWorkflow): FactoryFlowProblem[] {
  return parsed.nodes.flatMap((node) => {
    const command = node.run_command ?? node.bash;
    if (!command) return [];
    const problems: FactoryFlowProblem[] = [];
    if (command.cwd !== undefined) {
      problems.push({
        step: node.id,
        field: 'cwd',
        message:
          'run_command runs from the root of the run checkout: write `cd <dir> && …` instead of cwd',
      });
    }
    if ((command.timeout_ms ?? 0) > MAX_STEP_TIMEOUT_MS) {
      problems.push({
        step: node.id,
        field: 'timeout_ms',
        message: 'A command may run for at most an hour (3600000 ms)',
      });
    }
    return problems;
  });
}

/** The nodes that can produce a change again: a command, or an agent step. */
const producesChange = (node: ParsedWorkflow['nodes'][number]) =>
  !!(node.run_command || node.bash || node.spawn_agent);

/**
 * A `merge` that regenerates its change (`regenerate: <node>`, openspec
 * factory-integration D9): the node must exist and produce the change, and the
 * merge loop must go back to it, so a conflict re-runs it on the new base.
 */
function regenerateProblems(parsed: ParsedWorkflow): FactoryFlowProblem[] {
  return parsed.nodes.flatMap((node) => {
    const target = node.merge?.regenerate;
    if (!target) return [];
    const produced = parsed.nodes.find((other) => other.id === target);
    if (!produced || !producesChange(produced)) {
      return [
        {
          step: node.id,
          field: 'regenerate',
          message: `regenerate names "${target}", which is not a run_command, bash or agent step of this flow`,
        },
      ];
    }
    if (node.loop?.back_to !== target) {
      return [
        {
          step: node.id,
          field: 'regenerate',
          message: `the merge loop must go back to "${target}" (loop.back_to), so a conflict re-runs it on the new base`,
        },
      ];
    }
    return [];
  });
}

/**
 * Every reason the flow cannot run as a factory flow, given the factory's step
 * overrides (which may change a step's provider) and the project's defaults.
 * Run on the flow after its prompt files were resolved.
 */
export function validateFactoryFlow(
  parsed: ParsedWorkflow,
  context: { overrides?: StepOverrides; project?: ProjectAgentDefaults } = {},
): FactoryFlowProblem[] {
  const steps = listAgentSteps(parsed);
  const firstNode = firstAgentNode(parsed, steps);
  return [
    ...defaultsProblems(parsed),
    ...steps.flatMap((step) => stepProblems(step, parsed, firstNode, context)),
    ...commandProblems(parsed),
    ...regenerateProblems(parsed),
  ];
}

/** The steps that judge a change against the run's issue: a run without one cannot run them. */
const ISSUE_ONLY_STEPS: ReadonlySet<string> = new Set([
  'triage',
  'review',
  'regression_proof',
  'merge',
]);

/** The inputs the factory itself supplies to every flow; a trigger cannot replace them. */
export const FACTORY_FLOW_INPUTS: ReadonlySet<string> = new Set([
  'repo',
  'branch',
  'base_branch',
  'factory_id',
  'stack_branch',
  'spec',
  'spec_commit_path',
]);

/** The flow's inputs a run must be given a value for: required, and without a default. */
export function requiredFlowInputs(parsed: ParsedWorkflow): string[] {
  return Object.entries(parsed.inputs ?? {}).flatMap(([name, def]) =>
    def.required === true && def.default === undefined ? [name] : [],
  );
}

/**
 * Every reason the flow cannot run for a run WITHOUT an issue (change
 * flow-triggers), given the input names its trigger supplies: a step that
 * judges a change against an issue, or a required input nobody supplies. An
 * issue flow asks for `issue_number`, so it is refused by the second rule too.
 */
export function validateFlowForIssuelessRun(
  parsed: ParsedWorkflow,
  supplied: readonly string[],
): FactoryFlowProblem[] {
  const issueSteps = parsed.nodes.flatMap((node): FactoryFlowProblem[] => {
    const { type } = getWorkflowNodeAction(node);
    if (!ISSUE_ONLY_STEPS.has(type)) return [];
    return [
      {
        step: node.id,
        field: type,
        message: `a ${type} step judges a change against an issue, and this run has none`,
      },
    ];
  });
  const have = new Set(supplied);
  const missing = requiredFlowInputs(parsed)
    .filter((name) => !FACTORY_FLOW_INPUTS.has(name) && !have.has(name))
    .map((name): FactoryFlowProblem => ({
      step: 'flow',
      field: `inputs.${name}`,
      message: `the flow requires the input "${name}", and nothing supplies it`,
    }));
  return [...issueSteps, ...missing];
}

/** The problems as one message, one line each, for a run's failure reason. */
export function formatFactoryFlowProblems(origin: string, problems: FactoryFlowProblem[]): string {
  const lines = problems.map(({ step, field, message }) => `- step ${step}, ${field}: ${message}`);
  return [`${origin}: the issue factory cannot run this flow:`, ...lines].join('\n');
}

/** A step's own fields as `resolveStepOptions` reads them. */
function stepInput(action: FlowAgentStep['action']) {
  return {
    provider: action.provider,
    model: action.model,
    effort: action.effort,
    mode: action.permission_mode,
    allowedTools: action.allowed_tools,
    disallowedTools: action.denied_tools,
    thread: action.thread,
  };
}

/** The flow's `defaults:` as `resolveStepOptions` reads them. */
function defaultsInput(parsed: ParsedWorkflow) {
  const d = parsed.defaults;
  return {
    provider: d?.provider,
    model: d?.model,
    effort: d?.effort,
    permissionMode: d?.permission_mode,
    allowedTools: d?.allowed_tools,
    disallowedTools: d?.denied_tools,
  };
}

/** What Validate flow shows of a flow that loads: its steps and what each agent step runs with. */
export interface FactoryFlowSummary {
  steps: Array<{ id: string; kind: string }>;
  agentSteps: FactoryFlowAgentStep[];
  unusedOverrides: string[];
  warnings: string[];
}

/**
 * The flow's steps by kind and its agent steps with the options a run would
 * give them now (the same rule as runs, `resolveStepOptions`), the factory's
 * overrides that name no agent step, and the continuing steps whose model or
 * provider changes: the runtime then replays the thread's transcript into a new
 * session, which costs tokens and may lose detail.
 */
export function summarizeFactoryFlow(
  parsed: ParsedWorkflow,
  context: { overrides?: StepOverrides; project?: ProjectAgentDefaults } = {},
): FactoryFlowSummary {
  const overrides = context.overrides ?? {};
  const flowDefaults = defaultsInput(parsed);
  const agentSteps = listAgentSteps(parsed).map(({ step, action }): FactoryFlowAgentStep => {
    const resolved = resolveStepOptions({
      stepId: step,
      step: stepInput(action),
      flowDefaults,
      overrides,
      project: context.project,
    });
    const { stepId, provider, model, effort, permissionMode, allowedTools, disallowedTools } =
      resolved;
    return {
      stepId,
      provider,
      model,
      effort,
      permissionMode,
      allowedTools,
      disallowedTools,
      thread: resolved.thread,
      overridden: step in overrides,
    };
  });
  const known = new Set(agentSteps.map((step) => step.stepId));
  const continuing = agentSteps.filter((step) => step.thread === 'continue');
  const warnings = continuing.slice(1).flatMap((step, index) => {
    const before = continuing[index]!;
    if (before.provider === step.provider && before.model === step.model) return [];
    return [
      `Step ${step.stepId} continues the implementing thread on ${step.provider} ${step.model} after ${before.stepId} on ${before.provider} ${before.model}: the thread's transcript is replayed into a new session (context replay), which costs tokens and may lose detail.`,
    ];
  });
  return {
    steps: parsed.nodes.map((node) => ({ id: node.id, kind: getWorkflowNodeAction(node).type })),
    agentSteps,
    unusedOverrides: Object.keys(overrides).filter((stepId) => !known.has(stepId)),
    warnings,
  };
}
