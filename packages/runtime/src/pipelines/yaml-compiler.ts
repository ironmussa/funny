/**
 * YAML → PipelineDefinition compiler.
 *
 * Takes a `ParsedPipeline` (validated YAML from `@funny/pipelines/yaml`)
 * and produces a `PipelineDefinition` runnable by the existing engine.
 *
 * Phase 1 scope:
 *   - Topological sort over `depends_on` (each node depends on a subset
 *     of earlier nodes; output is a linear sequence)
 *   - Cycle detection
 *   - Per-pipeline single loop (one node may declare `loop:`); multiple
 *     loops will be supported when the engine becomes a DAG (Phase 3)
 *   - Action binding: each YAML action key maps to one ActionProvider call
 *   - Mustache interpolation of every string field at execution time
 *   - JSONata evaluation of `when` and `until`
 *
 * Out of scope here (deferred to Phase 3):
 *   - Parallel branches (multiple roots in the DAG)
 *   - Per-node loops (only one global loop allowed for now)
 *   - `trigger_rule` (none_failed_min_one_success, etc.)
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
  type NodeRetryConfig,
  type ParsedNode,
  type ParsedPipeline,
  type PipelineDefinition,
  type PipelineNode,
  type TemplateScope,
} from '@funny/pipelines';
import type { AgentDefinition } from '@funny/shared';

import { approvalNode } from './approval.js';
import type { PipelineContext } from './types.js';

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
  parsed: ParsedPipeline,
  options: CompileOptions = {},
): PipelineDefinition<YamlPipelineContext> {
  const ordered = topologicalSort(parsed);

  const loopNodes = ordered.filter((n) => n.loop !== undefined);
  if (loopNodes.length > 1) {
    throw new YamlCompileError(
      `Multiple per-node loops not supported until DAG engine lands (Phase 3). Found loops on: ${loopNodes
        .map((n) => n.id)
        .join(', ')}`,
      parsed.name,
    );
  }
  const loopNode = loopNodes[0];

  const engineNodes: PipelineNode<YamlPipelineContext>[] = ordered.map((yamlNode) =>
    buildEngineNode(yamlNode, parsed, options),
  );

  return definePipeline<YamlPipelineContext>({
    name: parsed.name,
    nodes: engineNodes,
    loop: loopNode
      ? {
          from: loopNode.loop!.back_to ?? loopNode.id,
          // The engine accepts async GuardFn — JSONata always returns a
          // Promise even for sync expressions, so we wire async-end-to-end.
          until: makePredicate(loopNode.loop!.until, parsed.name),
          maxIterations: loopNode.loop!.max_iterations,
        }
      : undefined,
  });
}

// ── Topological sort ────────────────────────────────────────

function topologicalSort(parsed: ParsedPipeline): ParsedNode[] {
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
  parsed: ParsedPipeline,
  options: CompileOptions,
): PipelineNode<YamlPipelineContext> {
  // Approval has its own helper that already wires WS + capture_response.
  if (yamlNode.approval) {
    return approvalNode<YamlPipelineContext>(yamlNode.id, {
      message: (ctx) => render(yamlNode.approval!.message, scopeOf(ctx)),
      captureResponse: yamlNode.approval.capture_response ?? false,
      timeoutMs: yamlNode.approval.timeout_ms,
      when: yamlNode.when ? makePredicate(yamlNode.when, parsed.name) : undefined,
    });
  }

  const retry = compileRetry(yamlNode, parsed, options);
  const onError = yamlNode.on_error;

  // Edge case: if both `retry` and `on_error: continue` are set, retry
  // takes precedence — the engine handles all retry attempts; if every
  // attempt fails, the pipeline fails. The "swallow final error" semantic
  // would require engine-level support (per-node `continueOnFinalError`)
  // and isn't implemented yet. Without retry, `on_error: continue` works
  // as documented — the dispatch error is swallowed and downstream nodes
  // see an empty output for this node.
  const swallowOnContinue = onError === 'continue' && !retry;

  return engineNode<YamlPipelineContext>(
    yamlNode.id,
    async (ctx) => {
      ctx.progress.onStepProgress(yamlNode.id, { status: 'running' });

      try {
        const output = await dispatch(yamlNode, ctx, parsed, options);
        ctx.progress.onStepProgress(yamlNode.id, { status: 'completed' });
        return {
          ...ctx,
          outputs: { ...ctx.outputs, [yamlNode.id]: output },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (swallowOnContinue) {
          ctx.progress.onStepProgress(yamlNode.id, {
            status: 'completed',
            metadata: { warning: message },
          });
          return {
            ...ctx,
            outputs: {
              ...ctx.outputs,
              [yamlNode.id]: { output: undefined, error: message },
            },
          };
        }
        // Re-throw so the engine's retry loop (if any) can catch it.
        ctx.progress.onStepProgress(yamlNode.id, { status: 'failed', error: message });
        throw err;
      }
    },
    {
      when: yamlNode.when ? makePredicate(yamlNode.when, parsed.name) : undefined,
      retry,
    },
  );
}

// ── Action dispatch ─────────────────────────────────────────

async function dispatch(
  yamlNode: ParsedNode,
  ctx: YamlPipelineContext,
  parsed: ParsedPipeline,
  options: CompileOptions,
): Promise<NodeOutput> {
  const scope = scopeOf(ctx);
  const provider = ctx.provider;

  if (yamlNode.spawn_agent) {
    const opts = interpolateObject(yamlNode.spawn_agent, scope);
    const agentDef = resolveAgentDefinition(opts, parsed, options);
    const result = await provider.spawnAgent({
      prompt: opts.prompt,
      cwd: ctx.cwd,
      agent: agentDef,
      model: opts.model,
      mode: coercePermissionMode(opts.permission_mode),
      allowedTools: opts.allowed_tools,
      disallowedTools: opts.denied_tools,
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

  if (yamlNode.set_status) {
    const opts = interpolateObject(yamlNode.set_status, scope);
    const threadId = resolveThreadId(ctx);
    const result = await provider.setStatus({
      threadId,
      value: opts.value,
      reason: opts.reason,
    });
    if (!result.ok) throw new Error(`set_status[${yamlNode.id}] failed: ${result.error}`);
    return { output: opts.value, json: { value: opts.value, reason: opts.reason } };
  }

  if (yamlNode.set_stage) {
    const opts = interpolateObject(yamlNode.set_stage, scope);
    const threadId = resolveThreadId(ctx);
    const result = await provider.setStage({
      threadId,
      value: opts.value,
      reason: opts.reason,
    });
    if (!result.ok) throw new Error(`set_stage[${yamlNode.id}] failed: ${result.error}`);
    return { output: opts.value, json: { value: opts.value, reason: opts.reason } };
  }

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
  parsed: ParsedPipeline,
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
          const fakeNode: ParsedNode = {
            id: `${yamlNode.id}-before-retry-${attempt}`,
            depends_on: [],
            on_error: 'fail',
            spawn_agent: cfg.before_retry,
          } as unknown as ParsedNode;

          const augmentedScope: YamlPipelineContext = {
            ...ctx,
            inputs: { ...ctx.inputs, LAST_ERROR: err.message, ATTEMPT: attempt },
          };
          await dispatch(fakeNode, augmentedScope, parsed, options);
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
  return { ...ctx.inputs, ...ctx.outputs };
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

function coercePermissionMode(
  mode: string | undefined,
): 'plan' | 'autoEdit' | 'confirmEdit' | undefined {
  if (mode === 'plan' || mode === 'autoEdit' || mode === 'confirmEdit') return mode;
  return undefined;
}

function resolveAgentDefinition(
  opts: NonNullable<ParsedNode['spawn_agent']>,
  parsed: ParsedPipeline,
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
