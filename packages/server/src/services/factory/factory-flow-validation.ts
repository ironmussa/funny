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

import type { AgentProvider } from '@funny/shared';
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

/** The problems of one agent step, its options resolved as a run would. */
function stepProblems(
  { step, action }: FlowAgentStep,
  parsed: ParsedWorkflow,
  firstNode: string | undefined,
  context: { overrides?: StepOverrides; project?: ProjectAgentDefaults },
): FactoryFlowProblem[] {
  const problems: FactoryFlowProblem[] = [];
  const add = (field: string, message: string) => problems.push({ step, field, message });

  for (const field of Object.keys(action)) {
    if (!APPLIED_FIELDS.has(field)) add(field, `${field} is not applied by the issue factory`);
  }
  if (action.permission_mode && !UNATTENDED_MODES.has(action.permission_mode)) {
    add('permission_mode', modeProblem(action.permission_mode));
  }
  if (action.provider && !KNOWN_PROVIDER_IDS.includes(action.provider)) {
    add('provider', `Unknown provider "${action.provider}"`);
  }
  const defaults = parsed.defaults;
  const pairProblem = providerModelProblem(
    action.provider ?? defaults?.provider,
    action.model ?? (action.provider ? undefined : defaults?.model),
  );
  if (pairProblem) add('model', pairProblem);

  const resolved = resolveStepOptions({
    stepId: step,
    step: stepInput(action),
    flowDefaults: defaultsInput(parsed),
    overrides: context.overrides,
    project: context.project,
  });
  if (!TOOL_POLICY_PROVIDERS.has(resolved.provider)) {
    for (const [field, list] of [
      ['allowed_tools', resolved.allowedTools],
      ['denied_tools', resolved.disallowedTools],
    ] as const) {
      if (list) {
        add(
          field,
          `${field} cannot be applied on provider "${resolved.provider}": only ${[...TOOL_POLICY_PROVIDERS].join(' and ')} apply tool lists`,
        );
      }
    }
  }
  if (resolved.thread === 'new') {
    if (resolved.permissionMode !== 'plan') {
      add(
        'thread',
        'thread: new runs beside the implementing thread, so it must be read-only (permission_mode: plan): only the implementing thread writes to the branch',
      );
    }
    if (!READ_ONLY_PROVIDERS.includes(resolved.provider as AgentProvider)) {
      add(
        'provider',
        `thread: new runs read-only, which only ${READ_ONLY_PROVIDERS.join(' and ')} can be held to; "${resolved.provider}" cannot`,
      );
    }
    if (step === firstNode) {
      add(
        'thread',
        'thread: new cannot be on the first agent step: it is the implementing thread the later steps continue',
      );
    }
  }
  return problems;
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
  ];
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
