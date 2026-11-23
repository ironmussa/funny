/**
 * YAML → PipelineDefinition compiler.
 *
 * Takes a `ParsedWorkflow` (validated YAML from `@funny/workflows`)
 * and produces a `PipelineDefinition` runnable by the existing engine.
 *
 * Each YAML node becomes one engine node with the same graph fields:
 *   - `depends_on` → `dependsOn`, `trigger_rule` → `triggerRule`
 *   - `on_error: continue` → `onError: 'continue'` (the node fails and its
 *     dependents follow their trigger rule); `retry` → the engine's retry
 *   - `loop` → a loop on that node (several loops, nested or disjoint)
 *   - `concurrency` → a concurrency group rendered from the run's inputs
 *   - Action binding: each YAML action key maps to one ActionProvider call;
 *     agent and merge actions get the execution (`resume`, `checkpoint`,
 *     and the batch when leading one)
 *   - Mustache interpolation of every string field at execution time, with
 *     `LOOP_ITERATION` (the innermost loop's visit) in scope
 *   - JSONata evaluation of `when` and `until`
 */

import {
  compilePredicate,
  definePipeline,
  evaluatePredicate,
  interpolate,
  interpolateObject,
  node as engineNode,
  runPipeline,
  type CompiledPredicate,
  type NodeConcurrency,
  type NodeRetryConfig,
  type NodeRunInfo,
  type PipelineDefinition,
  type PipelineNode,
  type TemplateScope,
} from '@funny/pipelines';
import type { AgentDefinition, PermissionMode } from '@funny/shared';

import type { ParsedNode, ParsedWorkflow } from '../schema.js';
import type {
  ActionResult,
  PipelineContext,
  RegressionProofOpts,
  ReviewOpts,
  SpawnAgentDefaults,
} from './action-provider.js';
import { approvalNode } from './approval.js';

// ── Compile-time errors ─────────────────────────────────────

export class YamlCompileError extends Error {
  constructor(
    message: string,
    public readonly pipelineName: string,
  ) {
    super(`Pipeline "${pipelineName}": ${message}`);
    this.name = 'YamlCompileError';
  }
}

// ── Context shape ───────────────────────────────────────────

/**
 * Runtime context for a YAML-defined pipeline.
 *
 * `inputs` carries the values supplied to the pipeline at invocation time.
 * `outputs` accumulates each node's result (keyed by node id) so later
 * nodes can reference them via `{{ node.output.field }}` (Mustache) or
 * `node-id.output.field` (JSONata).
 */
export interface YamlPipelineContext extends PipelineContext {
  inputs: Record<string, unknown>;
  outputs: Record<string, NodeOutput>;
  /**
   * The execution of the node being dispatched (set only while its action
   * runs, never carried to later nodes): its loop visit, resume data,
   * checkpoint and batch.
   */
  execution?: NodeRunInfo;
}

export interface NodeOutput {
  /** Raw output payload — string for shell/agent, object for parsed JSON. */
  output: unknown;
  /** Optional structured fields when `output_format` was set on the node. */
  json?: Record<string, unknown>;
  /** Captured stderr/error text when the action failed but `on_error` recovered. */
  error?: string;
}

// ── Resolver: agent registry → AgentDefinition ──────────────

/**
 * Function the compiler uses to resolve a YAML `agent: <name>` reference
 * to a runtime `AgentDefinition`. The runtime supplies its agent registry
 * here; the compiler stays agnostic of where definitions live.
 */
export type AgentResolver = (name: string) => AgentDefinition | undefined;

// ── Compiler options ────────────────────────────────────────

export interface CompileOptions {
  /**
   * Resolves named agents (e.g. `agent: reviewer`) to AgentDefinitions.
   * Required when any YAML node uses `spawn_agent.agent` by name.
   */
  resolveAgent?: AgentResolver;
  /**
   * Dispatch table for sub-pipeline calls (`pipeline:` action). Keyed by
   * pipeline name. When a YAML uses `pipeline: { name: foo }`, the compiler
   * looks up `subPipelines[foo]` and inlines it as a node.
   *
   * Phase 1 supports referencing other compiled YAML pipelines; for now
   * the caller is responsible for compiling and registering them.
   */
  subPipelines?: Record<string, PipelineDefinition<YamlPipelineContext>>;
}

// ── Public compile() ────────────────────────────────────────

export function compileYamlPipeline(
  parsed: ParsedWorkflow,
  options: CompileOptions = {},
): PipelineDefinition<YamlPipelineContext> {
  const ordered = topologicalSort(parsed);
  const engineNodes: PipelineNode<YamlPipelineContext>[] = ordered.map((yamlNode) =>
    buildEngineNode(yamlNode, parsed, options),
  );

  return definePipeline<YamlPipelineContext>({
    name: parsed.name,
    nodes: engineNodes,
    // Join merge: each node writes only its own `outputs[id]`, so folding the
    // outputs of a node's dependencies is collision-free. Other ctx fields
    // (inputs, cwd, provider, progress) are the same in every branch, so
    // taking them from the base is correct. Declaration order keeps the
    // merge deterministic regardless of which node finished first.
    mergeContexts: (base, results) => ({
      ...base,
      outputs: Object.assign({}, base.outputs, ...results.map((r) => r.outputs)),
    }),
  });
}

// ── Topological sort ────────────────────────────────────────

function topologicalSort(parsed: ParsedWorkflow): ParsedNode[] {
  const byId = new Map(parsed.nodes.map((n) => [n.id, n]));
  const sorted: ParsedNode[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();

  function visit(nodeId: string, path: string[]): void {
    if (visited.has(nodeId)) return;
    if (visiting.has(nodeId)) {
      throw new YamlCompileError(`Cycle detected: ${[...path, nodeId].join(' → ')}`, parsed.name);
    }
    const n = byId.get(nodeId);
    if (!n) {
      // Schema-level depends_on validation already checked existence;
      // this branch is just defensive.
      throw new YamlCompileError(`Unknown node "${nodeId}"`, parsed.name);
    }
    visiting.add(nodeId);
    for (const dep of n.depends_on) visit(dep, [...path, nodeId]);
    visiting.delete(nodeId);
    visited.add(nodeId);
    sorted.push(n);
  }

  for (const n of parsed.nodes) visit(n.id, []);
  return sorted;
}

// ── Per-node compiler ───────────────────────────────────────

function buildEngineNode(
  yamlNode: ParsedNode,
  parsed: ParsedWorkflow,
  options: CompileOptions,
): PipelineNode<YamlPipelineContext> {
  const graphFields = {
    dependsOn: yamlNode.depends_on,
    triggerRule: yamlNode.trigger_rule,
    onError: yamlNode.on_error === 'continue' ? ('continue' as const) : ('fail' as const),
    loop: compileLoop(yamlNode, parsed),
    concurrency: compileConcurrency(yamlNode),
  };
  const when = yamlNode.when ? makePredicate(yamlNode.when, parsed.name) : undefined;

  // Approval has its own helper that already wires WS + capture_response.
  if (yamlNode.approval) {
    return {
      ...approvalNode<YamlPipelineContext>(yamlNode.id, {
        message: (ctx) => render(yamlNode.approval!.message, scopeOf(ctx)),
        captureResponse: yamlNode.approval.capture_response ?? false,
        timeoutMs: yamlNode.approval.timeout_ms,
        when,
      }),
      ...graphFields,
    };
  }

  return engineNode<YamlPipelineContext>(
    yamlNode.id,
    async (ctx, _signal, info) => {
      ctx.progress.onStepProgress(yamlNode.id, { status: 'running' });
      try {
        const output = await dispatch(yamlNode, { ...ctx, execution: info }, parsed, options);
        ctx.progress.onStepProgress(yamlNode.id, { status: 'completed' });
        return { ...ctx, outputs: { ...ctx.outputs, [yamlNode.id]: output } };
      } catch (err) {
        // Rethrow so the engine applies `retry`, then `on_error`.
        const message = err instanceof Error ? err.message : String(err);
        ctx.progress.onStepProgress(yamlNode.id, { status: 'failed', error: message });
        throw err;
      }
    },
    { when, retry: compileRetry(yamlNode, parsed, options), ...graphFields },
  );
}

/** A YAML `loop` as an engine loop on the node. */
function compileLoop(yamlNode: ParsedNode, parsed: ParsedWorkflow) {
  const loop = yamlNode.loop;
  if (!loop) return undefined;
  return {
    backTo: loop.back_to ?? yamlNode.id,
    // JSONata always returns a Promise, so the guard is async end to end.
    until: makePredicate(loop.until, parsed.name),
    maxIterations: loop.max_iterations,
  };
}

/** A YAML `concurrency` as an engine concurrency group, rendered from the run's inputs. */
function compileConcurrency(
  yamlNode: ParsedNode,
): NodeConcurrency<YamlPipelineContext> | undefined {
  const concurrency = yamlNode.concurrency;
  if (!concurrency) return undefined;
  const { group, limit, batch } = concurrency;
  return {
    // Inputs both flat (`{{repo}}`, as elsewhere) and under `inputs.`.
    group: (initial) => render(group, { ...initial.inputs, inputs: initial.inputs }),
    limit,
    batch: batch && {
      max: batch.max,
      waitMs: batch.wait,
      adopt: (input, output) => ({
        ...input,
        outputs: { ...input.outputs, [yamlNode.id]: asNodeOutput(output) },
      }),
    },
  };
}

/** The output a batch leader settled for a member, as this node's output. */
function asNodeOutput(output: unknown): NodeOutput {
  if (output !== null && typeof output === 'object' && 'output' in output) {
    return output as NodeOutput;
  }
  return { output };
}

// ── Action dispatch ─────────────────────────────────────────

/**
 * Thread-lifecycle nodes (`set_status`, `set_stage`) — bound to the run's
 * thread by the provider; the YAML carries only the value + reason.
 * Returns `null` when `yamlNode` is not a lifecycle node.
 */
async function dispatchThreadLifecycleNode(
  yamlNode: ParsedNode,
  ctx: YamlPipelineContext,
  scope: TemplateScope,
): Promise<NodeOutput | null> {
  const action = yamlNode.set_status
    ? { name: 'set_status', raw: yamlNode.set_status, apply: ctx.provider.setStatus }
    : yamlNode.set_stage
      ? { name: 'set_stage', raw: yamlNode.set_stage, apply: ctx.provider.setStage }
      : null;
  if (!action) return null;

  const opts = interpolateObject(action.raw, scope);
  const result = await action.apply.call(ctx.provider, {
    threadId: resolveThreadId(ctx),
    value: opts.value,
    reason: opts.reason,
  });
  if (!result.ok) throw new Error(`${action.name}[${yamlNode.id}] failed: ${result.error}`);
  return { output: opts.value, json: { value: opts.value, reason: opts.reason } };
}

/**
 * GitHub CI/merge nodes (`wait_ci`, `merge`) — bound to the run's repo + PR
 * by the provider. Unsupported outside the factory's server provider, which
 * surfaces as a step error so `retry`/`on_error` act.
 * Returns `null` when `yamlNode` is not a GitHub node.
 */
async function dispatchGithubNode(
  yamlNode: ParsedNode,
  ctx: YamlPipelineContext,
  scope: TemplateScope,
  parsed: ParsedWorkflow,
): Promise<NodeOutput | null> {
  if (yamlNode.wait_ci)
    return githubOutput(yamlNode, 'wait_ci', await waitCi(yamlNode, ctx, scope, parsed));
  if (yamlNode.merge)
    return githubOutput(yamlNode, 'merge', await merge(yamlNode, ctx, scope, parsed));
  if (yamlNode.regression_proof) {
    return githubOutput(yamlNode, 'regression_proof', await regressionProof(yamlNode, ctx, scope));
  }
  if (yamlNode.review) return githubOutput(yamlNode, 'review', await review(yamlNode, ctx, scope));
  if (yamlNode.triage) return githubOutput(yamlNode, 'triage', await triage(yamlNode, ctx, scope));
  if (yamlNode.integrate)
    return githubOutput(yamlNode, 'integrate', await integrate(yamlNode, ctx));
  return null;
}

/** A GitHub action's result as the node's output; a failure is the step's error. */
function githubOutput(yamlNode: ParsedNode, kind: string, result: ActionResult): NodeOutput {
  if (!result.ok) throw new Error(`${kind}[${yamlNode.id}] failed: ${result.error}`);
  return { output: result.output ?? '', json: result.metadata };
}

function waitCi(
  yamlNode: ParsedNode,
  ctx: YamlPipelineContext,
  scope: TemplateScope,
  parsed: ParsedWorkflow,
) {
  const opts = interpolateObject(yamlNode.wait_ci!, scope);
  return ctx.provider.waitCi({
    timeoutMs: opts.timeout_ms,
    intervalMs: opts.interval_ms,
    requiredChecks: opts.required_checks,
    earlyReview: earlyReviewOpts(parsed, scope),
  });
}

/** The flow's `review` step as provider options, when it has one that starts with the checks. */
function earlyReviewOpts(parsed: ParsedWorkflow, scope: TemplateScope): ReviewOpts | undefined {
  const reviewNode = parsed.nodes.find((n) => n.review !== undefined);
  if (!reviewNode?.review || reviewNode.review.early === false) return undefined;
  const opts = interpolateObject(reviewNode.review, scope);
  return { provider: opts.provider, model: opts.model, effort: opts.effort, early: true };
}

function merge(
  yamlNode: ParsedNode,
  ctx: YamlPipelineContext,
  scope: TemplateScope,
  parsed: ParsedWorkflow,
) {
  const opts = interpolateObject(yamlNode.merge!, scope);
  const proofNode = parsed.nodes.find((n) => n.regression_proof !== undefined);
  return ctx.provider.merge({
    method: opts.method,
    deleteBranch: opts.delete_branch,
    auto: opts.auto,
    execution: ctx.execution,
    requireRegressionProof: opts.require_regression_proof ?? true,
    requireReview: opts.require_review ?? true,
    regenerate: opts.regenerate,
    regressionProof: proofNode
      ? regressionProofOpts(interpolateObject(proofNode.regression_proof!, scope))
      : undefined,
  });
}

function triage(yamlNode: ParsedNode, ctx: YamlPipelineContext, scope: TemplateScope) {
  if (!ctx.provider.triage) {
    throw new Error(`triage[${yamlNode.id}]: the provider does not support this action`);
  }
  const opts = interpolateObject(yamlNode.triage!, scope);
  return ctx.provider.triage({
    provider: opts.provider,
    model: opts.model,
    effort: opts.effort,
    execution: ctx.execution,
  });
}

function integrate(yamlNode: ParsedNode, ctx: YamlPipelineContext) {
  if (!ctx.provider.integrate) {
    throw new Error(`integrate[${yamlNode.id}]: the provider does not support this action`);
  }
  return ctx.provider.integrate({ execution: ctx.execution });
}

function review(yamlNode: ParsedNode, ctx: YamlPipelineContext, scope: TemplateScope) {
  if (!ctx.provider.review) {
    throw new Error(`review[${yamlNode.id}]: the provider does not support this action`);
  }
  const opts = interpolateObject(yamlNode.review!, scope);
  return ctx.provider.review({
    provider: opts.provider,
    model: opts.model,
    effort: opts.effort,
    early: opts.early,
    execution: ctx.execution,
  });
}

function regressionProof(yamlNode: ParsedNode, ctx: YamlPipelineContext, scope: TemplateScope) {
  if (!ctx.provider.regressionProof) {
    throw new Error(`regression_proof[${yamlNode.id}]: the provider does not support this action`);
  }
  const opts = interpolateObject(yamlNode.regression_proof!, scope);
  return ctx.provider.regressionProof(regressionProofOpts(opts));
}

/** A `regression_proof` step's YAML configuration as provider options. */
export function regressionProofOpts(
  opts: NonNullable<ParsedNode['regression_proof']>,
): RegressionProofOpts {
  return {
    rules: opts.rules ?? [],
    supportGlobs: opts.support_globs,
    requireTest: opts.require_test,
    labels: opts.labels,
    exemptLabels: opts.exempt_labels,
    setupCommand: opts.setup_command,
    timeoutMs: opts.timeout_ms,
  };
}

async function dispatch(
  yamlNode: ParsedNode,
  ctx: YamlPipelineContext,
  parsed: ParsedWorkflow,
  options: CompileOptions,
  /** The step id the provider sees; the node id unless a synthesized node stands for a step. */
  stepId: string = yamlNode.id,
): Promise<NodeOutput> {
  const scope = scopeOf(ctx);
  const provider = ctx.provider;

  if (yamlNode.spawn_agent) {
    const opts = interpolateObject(yamlNode.spawn_agent, scope);
    const agentDef = resolveAgentDefinition(opts, parsed, options);
    const result = await provider.spawnAgent({
      prompt: promptOf(opts, stepId, parsed),
      cwd: ctx.cwd,
      agent: agentDef,
      stepId,
      model: opts.model,
      provider: opts.provider,
      effort: opts.effort,
      thread: opts.thread,
      mode: coercePermissionMode(opts.permission_mode),
      allowedTools: opts.allowed_tools,
      disallowedTools: opts.denied_tools,
      defaults: flowDefaults(parsed),
      execution: ctx.execution,
    });
    if (!result.ok) throw new Error(`spawn_agent[${yamlNode.id}] failed: ${result.error}`);

    let json: Record<string, unknown> | undefined;
    if (yamlNode.spawn_agent.output_format && result.output) {
      json = tryParseJson(result.output);
      // Schema enforcement is intentionally not done here — the runtime
      // SDK doesn't expose a structured-output API yet, so output_format
      // is advisory. Phase 2 (replace) will wire it through.
    }
    return { output: result.output ?? '', json };
  }

  if (yamlNode.run_command || yamlNode.bash) {
    const action = yamlNode.run_command ?? yamlNode.bash!;
    const opts = interpolateObject(action, scope);
    const result = await provider.runCommand({
      command: opts.command,
      cwd: opts.cwd ?? ctx.cwd,
      timeout: opts.timeout_ms,
    });
    if (!result.ok) throw new Error(`run_command[${yamlNode.id}] failed: ${result.error}`);
    return { output: result.output ?? '' };
  }

  if (yamlNode.git_commit) {
    const opts = interpolateObject(yamlNode.git_commit, scope);
    const result = await provider.gitCommit({
      cwd: ctx.cwd,
      message: opts.message,
      files: opts.files,
      amend: opts.amend,
      noVerify: opts.no_verify,
    });
    if (!result.ok) throw new Error(`git_commit[${yamlNode.id}] failed: ${result.error}`);
    return { output: result.output ?? '', json: result.metadata };
  }

  if (yamlNode.git_push) {
    const opts = interpolateObject(yamlNode.git_push, scope);
    const result = await provider.gitPush({
      cwd: ctx.cwd,
      branch: opts.branch,
      setUpstream: opts.set_upstream,
      force: opts.force,
    });
    if (!result.ok) throw new Error(`git_push[${yamlNode.id}] failed: ${result.error}`);
    return { output: result.output ?? '' };
  }

  if (yamlNode.create_pr) {
    const opts = interpolateObject(yamlNode.create_pr, scope);
    const result = await provider.createPr({
      cwd: ctx.cwd,
      title: opts.title,
      body: opts.body,
      base: opts.base,
      draft: opts.draft,
    });
    if (!result.ok) throw new Error(`create_pr[${yamlNode.id}] failed: ${result.error}`);
    return { output: result.output ?? '' };
  }

  if (yamlNode.notify) {
    const opts = interpolateObject(yamlNode.notify, scope);
    await provider.notify({ message: opts.message, level: opts.level });
    return { output: opts.message };
  }

  const lifecycle = await dispatchThreadLifecycleNode(yamlNode, ctx, scope);
  if (lifecycle) return lifecycle;

  const github = await dispatchGithubNode(yamlNode, ctx, scope, parsed);
  if (github) return github;

  if (yamlNode.pipeline) {
    const subName = yamlNode.pipeline.name;
    const sub = options.subPipelines?.[subName];
    if (!sub) {
      throw new YamlCompileError(
        `Pipeline reference "${subName}" not found in subPipelines registry. ` +
          `Compile and pass the referenced pipeline via options.subPipelines.`,
        parsed.name,
      );
    }
    // Inline run: same provider/progress/cwd, fresh inputs scope.
    const subInputs = yamlNode.pipeline.inputs
      ? interpolateObject(yamlNode.pipeline.inputs, scope)
      : {};
    const result = await runPipeline(sub, {
      ...ctx,
      inputs: { ...ctx.inputs, ...subInputs },
      outputs: {},
    });
    if (result.outcome !== 'completed') {
      throw new Error(
        `pipeline[${yamlNode.id}] sub "${subName}" ${result.outcome}: ${result.error ?? ''}`,
      );
    }
    return { output: result.ctx.outputs };
  }

  // approval is handled before dispatch (above).
  throw new YamlCompileError(
    `Node "${yamlNode.id}" has no action — schema validation should have caught this`,
    parsed.name,
  );
}

// ── Retry compiler ──────────────────────────────────────────

function compileRetry(
  yamlNode: ParsedNode,
  parsed: ParsedWorkflow,
  options: CompileOptions,
): NodeRetryConfig<YamlPipelineContext> | undefined {
  if (!yamlNode.retry) return undefined;
  const cfg = yamlNode.retry;

  return {
    maxAttempts: cfg.max_attempts,
    delayMs: cfg.delay_ms,
    shouldRetry: cfg.should_retry
      ? (() => {
          const compiled = compilePredicate(cfg.should_retry);
          return async (err: Error, ctx: YamlPipelineContext, attempt: number) => {
            const scope: TemplateScope = {
              ...scopeOf(ctx),
              error: err.message,
              attempt,
            };
            return evaluatePredicate(compiled, scope);
          };
        })()
      : undefined,
    beforeRetry: cfg.before_retry
      ? async (err, ctx, attempt) => {
          // Schema restricts `before_retry` to a spawn_agent shape — we
          // synthesize a single-action node and dispatch it inline. The
          // previous error is exposed as `LAST_ERROR` and the failed
          // attempt number as `ATTEMPT` in the prompt scope.
          const fakeNode = {
            id: `${yamlNode.id}-before-retry-${attempt}`,
            depends_on: [],
            on_error: 'fail' as const,
            spawn_agent: cfg.before_retry,
          } satisfies Partial<ParsedNode> as ParsedNode;

          const augmentedScope: YamlPipelineContext = {
            ...ctx,
            inputs: { ...ctx.inputs, LAST_ERROR: err.message, ATTEMPT: attempt },
          };
          await dispatch(fakeNode, augmentedScope, parsed, options, `${yamlNode.id}.before_retry`);
          return ctx;
        }
      : undefined,
  };
}

// ── Helpers ─────────────────────────────────────────────────

function resolveThreadId(ctx: YamlPipelineContext): string {
  const raw = ctx.inputs.threadId;
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error(
      'set_status / set_stage actions require inputs.threadId — the dispatcher must seed it on YamlPipelineContext.inputs',
    );
  }
  return raw;
}

function scopeOf(ctx: YamlPipelineContext): TemplateScope {
  // Flat shape so YAML can write `{{branch}}` (input) and `{{review.output.verdict}}` (node output).
  const scope: TemplateScope = { ...ctx.inputs, ...ctx.outputs };
  if (ctx.execution) scope.LOOP_ITERATION = ctx.execution.iteration;
  return scope;
}

function render(template: string, scope: TemplateScope): string {
  return interpolate(template, scope);
}

function makePredicate(
  expression: string,
  pipelineName: string,
): (ctx: YamlPipelineContext) => Promise<boolean> {
  // Compile once when the pipeline is built, evaluate per call.
  let compiled: CompiledPredicate;
  try {
    compiled = compilePredicate(expression);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new YamlCompileError(
      `Predicate "${expression}" failed to compile: ${message}`,
      pipelineName,
    );
  }
  return async (ctx) => {
    try {
      return await evaluatePredicate(compiled, scopeOf(ctx));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new YamlCompileError(`Predicate "${expression}" failed: ${message}`, pipelineName);
    }
  };
}

/** Pull JSON out of an agent response, ignoring surrounding prose. */
function tryParseJson(text: string): Record<string, unknown> | undefined {
  // Try fenced ```json``` first.
  const fenced = text.match(/```json\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]);
    } catch {
      /* fall through */
    }
  }
  // Try the first balanced {...} block.
  let depth = 0;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          start = -1;
        }
      }
    }
  }
  return undefined;
}

const PERMISSION_MODES: readonly PermissionMode[] = [
  'plan',
  'auto',
  'autoEdit',
  'confirmEdit',
  'ask',
];

/** The flow's permission mode as written; the host decides which ones it allows. */
function coercePermissionMode(mode: string | undefined): PermissionMode | undefined {
  return PERMISSION_MODES.find((known) => known === mode);
}

/** A step's prompt. A `prompt_file` the host did not resolve is refused, never sent empty. */
function promptOf(
  opts: NonNullable<ParsedNode['spawn_agent']>,
  stepId: string,
  parsed: ParsedWorkflow,
): string {
  if (opts.prompt !== undefined) return opts.prompt;
  throw new YamlCompileError(
    `Step ${stepId}: prompt_file is not supported here (the host did not resolve prompt files)`,
    parsed.name,
  );
}

/** The flow's `defaults:` block as provider options, or undefined without one. */
function flowDefaults(parsed: ParsedWorkflow): SpawnAgentDefaults | undefined {
  const d = parsed.defaults;
  if (!d) return undefined;
  return {
    provider: d.provider,
    model: d.model,
    effort: d.effort,
    permissionMode: d.permission_mode,
    allowedTools: d.allowed_tools,
    disallowedTools: d.denied_tools,
  };
}

function resolveAgentDefinition(
  opts: NonNullable<ParsedNode['spawn_agent']>,
  parsed: ParsedWorkflow,
  options: CompileOptions,
): AgentDefinition | undefined {
  if (!opts.agent) return undefined;
  if (!options.resolveAgent) {
    throw new YamlCompileError(
      `Node references agent "${opts.agent}" but no resolveAgent was passed to compileYamlPipeline`,
      parsed.name,
    );
  }
  const def = options.resolveAgent(opts.agent);
  if (!def) {
    throw new YamlCompileError(
      `Unknown agent: "${opts.agent}". Add it to the agent registry or define it inline.`,
      parsed.name,
    );
  }
  return def;
}
