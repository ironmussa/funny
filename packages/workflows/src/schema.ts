/**
 * Zod schema for funny workflow YAML.
 *
 * The schema captures the shape of `.funny/workflows/*.yaml` files. Each
 * node has exactly one action key (`spawn_agent`, `git_commit`, etc.)
 * matching one of the methods on `ActionProvider`.
 *
 * Field naming follows snake_case to match Archon conventions so that
 * Archon `.archon/workflows/*.yaml` files can be loaded with at most a
 * thin shim layer.
 *
 * Strict mode: unknown fields fail to parse with a clear error message.
 * This is intentional — we'd rather catch typos at load time than silently
 * ignore configuration the user thought was applied.
 *
 * Design note — `on_reject` and `before_retry` are limited to a
 * `spawn_agent` shape (not the full action union). This breaks the
 * recursive zod schema and matches Archon's behavior where both fields
 * accept only an AI prompt. If a richer action set is needed later, the
 * schema can be promoted to a recursive union with explicit type
 * annotations. Until then, simpler is better.
 */

import { z } from 'zod';

import { graphIssues } from './validate.js';

// ── Action option schemas ───────────────────────────────────

const spawnAgentAction = z
  .object({
    /** Named agent (resolved from agent registry) OR inline definition. */
    agent: z.string().optional(),
    /** Inline agent definition fields (override registry). */
    model: z.string().optional(),
    provider: z.string().optional(),
    permission_mode: z.enum(['plan', 'auto', 'autoEdit', 'confirmEdit', 'ask']).optional(),
    /** Mustache-templated prompt. */
    prompt: z.string(),
    /** Tool allow-list (cuts the agent's available tools). */
    allowed_tools: z.array(z.string()).optional(),
    /** Tool deny-list. */
    denied_tools: z.array(z.string()).optional(),
    /**
     * Optional structured output schema. When provided, the agent's
     * response is validated against this shape and exposed as
     * `node-id.output.<field>` for downstream nodes.
     */
    output_format: z
      .object({
        type: z.literal('object'),
        properties: z.record(z.string(), z.unknown()),
        required: z.array(z.string()).optional(),
      })
      .optional(),
  })
  .strict();

const runCommandAction = z
  .object({
    command: z.string(),
    cwd: z.string().optional(),
    timeout_ms: z.number().int().positive().optional(),
  })
  .strict();

const gitCommitAction = z
  .object({
    message: z.string(),
    files: z.array(z.string()).optional(),
    amend: z.boolean().optional(),
    no_verify: z.boolean().optional(),
  })
  .strict();

const gitPushAction = z
  .object({
    branch: z.string().optional(),
    set_upstream: z.boolean().optional(),
    force: z.boolean().optional(),
  })
  .strict();

const createPrAction = z
  .object({
    title: z.string(),
    body: z.string().optional(),
    base: z.string().optional(),
    draft: z.boolean().optional(),
  })
  .strict();

const notifyAction = z
  .object({
    message: z.string(),
    level: z.enum(['info', 'warning', 'error']).optional(),
  })
  .strict();

// ── Thread lifecycle actions ────────────────────────────────
//
// `set_status` and `set_stage` are domain actions that mutate the
// dispatched thread's lifecycle fields. They're intentionally
// thread-implicit: the dispatcher binds them to the thread it's
// running for, so YAML authors don't have to thread an id through.
// Values are validated against the runtime ThreadStatus / ThreadStage
// enums by the ActionProvider — keeping the YAML schema decoupled
// from runtime type changes (string here, runtime narrows later).
const setStatusAction = z
  .object({
    /** New ThreadStatus value (validated by the runtime provider). */
    value: z.string(),
    /** Optional human-readable explanation captured in WS event metadata. */
    reason: z.string().optional(),
  })
  .strict();

const setStageAction = z
  .object({
    /** New ThreadStage value (validated by the runtime provider). */
    value: z.string(),
    /** Optional human-readable explanation captured in WS event metadata. */
    reason: z.string().optional(),
  })
  .strict();

// ── GitHub integration actions ──────────────────────────────
//
// `wait_ci` and `merge` are run-implicit, like `set_status`/`set_stage`: the
// provider binds them to the run's pull request, so YAML authors pass only the
// knobs, not a repo or PR id. The provider (the issue factory's, server-side)
// does the GitHub work under a repo-scoped token.
const waitCiAction = z
  .object({
    /** Overall budget before the step gives up with a timeout verdict. */
    timeout_ms: z.number().int().positive().optional(),
    /** Poll cadence while checks are pending. */
    interval_ms: z.number().int().positive().optional(),
    /**
     * Subset of check names that must pass; default is every required check
     * the repository reports for the PR's head.
     */
    required_checks: z.array(z.string()).optional(),
  })
  .strict();

const mergeAction = z
  .object({
    /** Merge strategy; default decided by the provider / repository. */
    method: z.enum(['merge', 'squash', 'rebase']).optional(),
    /** Delete the head branch after a successful merge. */
    delete_branch: z.boolean().optional(),
    /** Enable auto-merge instead of merging directly (for required-check repos). */
    auto: z.boolean().optional(),
    /** When false, skip the regression proof gate on merge (default true). */
    require_regression_proof: z.boolean().optional(),
  })
  .strict();

// ── Regression proof action ────────────────────────────────

const regressionProofRule = z
  .object({
    /** Globs that identify test files for this rule. */
    globs: z.array(z.string()).min(1),
    /** Test command with a `{{files}}` placeholder for matched files. */
    command: z.string(),
    /** Working directory relative to the repository root (default: root). */
    cwd: z.string().optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (!val.command.includes('{{files}}')) {
      ctx.addIssue({
        code: 'custom',
        message: 'regression_proof rule command must contain a {{files}} placeholder',
      });
    }
    if (val.cwd?.includes('..')) {
      ctx.addIssue({
        code: 'custom',
        message: 'regression_proof rule cwd must not contain ".." (path traversal)',
      });
    }
  });

const regressionProofAction = z
  .object({
    /** Rules mapping test file globs to commands. Empty means not configured. */
    rules: z.array(regressionProofRule).default([]),
    /** Globs of test support files copied to the base with the tests. */
    support_globs: z.array(z.string()).optional(),
    /** Whether a changed test is required. */
    require_test: z.enum(['always', 'labels', 'never']).optional(),
    /** Issue labels that require a test when require_test is 'labels'. */
    labels: z.array(z.string()).optional(),
    /** Issue labels that need no test even when require_test is 'always' (e.g. docs, chore). */
    exempt_labels: z.array(z.string()).optional(),
    /** Run in each temporary checkout before the tests (e.g. `bun install --frozen-lockfile`). */
    setup_command: z.string().min(1).optional(),
    /** Time limit for the proof in milliseconds. */
    timeout_ms: z.number().int().positive().optional(),
  })
  .strict();

const approvalAction = z
  .object({
    /** User-facing message (Mustache-templated). */
    message: z.string(),
    /** If true, capture the approver's comment as `<node-id>.output`. */
    capture_response: z.boolean().optional(),
    /** Optional timeout in milliseconds. */
    timeout_ms: z.number().int().positive().optional(),
    /**
     * Optional reject hook: re-spawn a fixer agent when rejected. The
     * `$REJECTION_REASON` variable is available in the prompt scope.
     * Limited to spawn_agent shape — see file header for rationale.
     */
    on_reject: spawnAgentAction.optional(),
  })
  .strict();

/** Reference to another workflow/pipeline by name (composition). */
const pipelineCallAction = z
  .object({
    /** Named pipeline to invoke (loaded from the same `.funny/workflows/` dir). */
    name: z.string(),
    /** Optional input overrides for the called pipeline. */
    inputs: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

// ── Per-node retry & loop ───────────────────────────────────

const retryConfig = z
  .object({
    max_attempts: z.number().int().positive(),
    delay_ms: z.number().int().nonnegative().optional(),
    /** JSONata predicate evaluated against `{ error, attempt, ...scope }`. */
    should_retry: z.string().optional(),
    /**
     * Optional fixer agent run between attempts. The previous error is
     * exposed as `LAST_ERROR` in the prompt scope. Limited to spawn_agent
     * shape — see file header for rationale.
     */
    before_retry: spawnAgentAction.optional(),
  })
  .strict();

const loopConfig = z
  .object({
    /** JSONata predicate. When it evaluates to true, the loop exits. */
    until: z.string(),
    max_iterations: z.number().int().positive().default(10),
    /**
     * The first node of the loop's region: this node or one it depends on
     * (directly or not). Every node on a path from it to this node runs again.
     * Default: re-runs the current node only.
     */
    back_to: z.string().optional(),
  })
  .strict();

/** A duration: milliseconds, or a number with a unit (`500ms`, `60s`, `5m`, `1h`). */
const DURATION_UNITS_MS = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 } as const;
const duration = z.union([
  z.number().int().nonnegative(),
  z
    .string()
    .regex(/^\d+(ms|s|m|h)$/, { message: 'Use a duration like 500ms, 60s, 5m or 1h' })
    .transform((raw) => {
      const [, amount, unit] = /^(\d+)(ms|s|m|h)$/.exec(raw)!;
      return Number(amount) * DURATION_UNITS_MS[unit as keyof typeof DURATION_UNITS_MS];
    }),
]);

/**
 * Limit a node across every run that shares the host: at most `limit`
 * executions of nodes in `group` at once. `group` is a Mustache template
 * over the run's inputs only (never node outputs), e.g. `merge-{{repo}}`.
 * With `batch`, one execution serves up to `max` waiting runs.
 */
const concurrencyConfig = z
  .object({
    group: z.string().min(1),
    limit: z.number().int().positive(),
    batch: z
      .object({
        /** Most runs in one batch, the leader included. */
        max: z.number().int().min(2),
        /** How long the leader waits for more runs before it starts. */
        wait: duration,
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.batch && val.limit !== 1) {
      ctx.addIssue({ code: 'custom', message: 'A batching concurrency group must have limit 1' });
    }
  });

/** How a node joins its dependencies. */
export const TRIGGER_RULES = ['all_success', 'all_done', 'one_success'] as const;

// ── Action keys (one of) ────────────────────────────────────

/**
 * Every node action key. The single list the parser, the serializer, the graph
 * view and the editor share: a key missing from it is dropped on save.
 */
export const ACTION_KEYS = [
  'spawn_agent',
  'run_command',
  'bash',
  'git_commit',
  'git_push',
  'create_pr',
  'notify',
  'set_status',
  'set_stage',
  'wait_ci',
  'merge',
  'approval',
  'pipeline',
  'regression_proof',
] as const;

export type WorkflowActionKey = (typeof ACTION_KEYS)[number];

// ── Workflow node ───────────────────────────────────────────

const inputDef = z
  .object({
    type: z.enum(['string', 'number', 'boolean', 'object', 'array']),
    required: z.boolean().optional(),
    default: z.unknown().optional(),
    description: z.string().optional(),
  })
  .strict();

const pipelineNodeFields = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/, {
      message: 'Node id must be lowercase, start with a letter, and contain only [a-z0-9-]',
    }),
    /** IDs of nodes that must complete before this one starts (DAG). */
    depends_on: z.array(z.string()).default([]),
    /**
     * When the node starts, given its dependencies (default `all_success`):
     *   - 'all_success' — no dependency failed (a skipped one counts as done)
     *   - 'all_done' — every dependency finished, whatever the result
     *   - 'one_success' — as soon as one dependency succeeded
     * A node whose rule can no longer be met is skipped.
     */
    trigger_rule: z.enum(TRIGGER_RULES).optional(),
    concurrency: concurrencyConfig.optional(),
    /**
     * JSONata predicate. If it evaluates to false, the node is skipped.
     * Evaluated against the full workflow scope (inputs + node outputs).
     */
    when: z.string().optional(),
    /**
     * What to do if this node fails:
     *   - 'fail' (default) — the workflow fails
     *   - 'continue' — the node is marked failed and the run goes on; its
     *     dependents follow their `trigger_rule` (with the default
     *     `all_success` they are skipped; `all_done` runs them anyway)
     *   - 'retry' — apply the `retry:` config below
     */
    on_error: z.enum(['fail', 'continue', 'retry']).default('fail'),
    retry: retryConfig.optional(),
    loop: loopConfig.optional(),
    // Action keys (exactly one must be present — checked in superRefine).
    spawn_agent: spawnAgentAction.optional(),
    run_command: runCommandAction.optional(),
    bash: runCommandAction.optional(), // Archon-compat alias
    git_commit: gitCommitAction.optional(),
    git_push: gitPushAction.optional(),
    create_pr: createPrAction.optional(),
    notify: notifyAction.optional(),
    set_status: setStatusAction.optional(),
    set_stage: setStageAction.optional(),
    wait_ci: waitCiAction.optional(),
    merge: mergeAction.optional(),
    approval: approvalAction.optional(),
    pipeline: pipelineCallAction.optional(),
    regression_proof: regressionProofAction.optional(),
  })
  .strict();

const pipelineNode = pipelineNodeFields.superRefine((val, ctx) => {
  const present = ACTION_KEYS.filter((k) => (val as Record<string, unknown>)[k] !== undefined);
  if (present.length === 0) {
    ctx.addIssue({
      code: 'custom',
      message: `Node "${val.id}" must declare exactly one action (${ACTION_KEYS.join(', ')})`,
    });
  } else if (present.length > 1) {
    ctx.addIssue({
      code: 'custom',
      message: `Node "${val.id}" declares multiple actions: ${present.join(', ')}. Only one allowed.`,
    });
  }
});

// ── Pipeline ─────────────────────────────────────────────────

export const workflowSchema = z
  .object({
    /** Workflow name. Must match the filename (without extension). */
    name: z.string().regex(/^[a-z][a-z0-9-]*$/, {
      message: 'Workflow name must be lowercase, start with a letter, and contain only [a-z0-9-]',
    }),
    description: z.string().optional(),
    /** Default values applied to every node unless overridden. */
    defaults: z
      .object({
        provider: z.string().optional(),
        model: z.string().optional(),
        permission_mode: z.string().optional(),
      })
      .strict()
      .optional(),
    /** Typed inputs the pipeline expects when invoked. */
    inputs: z.record(z.string(), inputDef).optional(),
    nodes: z.array(pipelineNode).min(1, 'Workflow must declare at least one node'),
  })
  .strict()
  .superRefine((val, ctx) => {
    for (const message of graphIssues(val)) ctx.addIssue({ code: 'custom', message });
  });

// ── Inferred types ──────────────────────────────────────────

export type ParsedWorkflow = z.infer<typeof workflowSchema>;
export type ParsedNode = z.infer<typeof pipelineNode>;
export type ParsedInputDef = z.infer<typeof inputDef>;
export type ParsedRetry = z.infer<typeof retryConfig>;
export type ParsedLoop = z.infer<typeof loopConfig>;
export type ParsedConcurrency = z.infer<typeof concurrencyConfig>;
export type TriggerRuleName = (typeof TRIGGER_RULES)[number];
export type ParsedRegressionProofRule = z.infer<typeof regressionProofRule>;

/**
 * A flow is proof-ready when its `merge` step does not require the proof
 * (opt-out or no merge step), or its `regression_proof` step has at least
 * one rule.
 */
export function isProofReady(workflow: ParsedWorkflow): boolean {
  const mergeNode = workflow.nodes.find((n) => n.merge !== undefined);
  if (!mergeNode) return true;
  if (mergeNode.merge!.require_regression_proof === false) return true;
  const proofNode = workflow.nodes.find((n) => n.regression_proof !== undefined);
  return proofNode !== undefined && (proofNode.regression_proof!.rules?.length ?? 0) > 0;
}
