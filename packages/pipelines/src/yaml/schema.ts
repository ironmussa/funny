/**
 * Zod schema for funny pipeline YAML.
 *
 * The schema captures the shape of `.funny/pipelines/*.yaml` files. Each
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
        properties: z.record(z.string(), z.any()),
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

/** Reference to another pipeline by name (composition). */
const pipelineCallAction = z
  .object({
    /** Named pipeline to invoke (loaded from the same `.funny/pipelines/` dir). */
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
     * Optional id of an earlier node to jump back to on each iteration.
     * Default: re-runs the current node only.
     */
    back_to: z.string().optional(),
  })
  .strict();

// ── Action keys (one of) ────────────────────────────────────

const ACTION_KEYS = [
  'spawn_agent',
  'run_command',
  'bash',
  'git_commit',
  'git_push',
  'create_pr',
  'notify',
  'set_status',
  'set_stage',
  'approval',
  'pipeline',
] as const;

// ── Pipeline node ───────────────────────────────────────────

const inputDef = z
  .object({
    type: z.enum(['string', 'number', 'boolean', 'object', 'array']),
    required: z.boolean().optional(),
    default: z.unknown().optional(),
    description: z.string().optional(),
  })
  .strict();

const pipelineNodeShape = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/, {
      message: 'Node id must be lowercase, start with a letter, and contain only [a-z0-9-]',
    }),
    /** IDs of nodes that must complete before this one starts (DAG). */
    depends_on: z.array(z.string()).default([]),
    /**
     * JSONata predicate. If it evaluates to false, the node is skipped.
     * Evaluated against the full pipeline scope (inputs + node outputs).
     */
    when: z.string().optional(),
    /**
     * What to do if this node fails:
     *   - 'fail' (default) — the pipeline fails
     *   - 'continue' — the failure is logged but the pipeline continues
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
    approval: approvalAction.optional(),
    pipeline: pipelineCallAction.optional(),
  })
  .strict();

const pipelineNode = pipelineNodeShape.superRefine((val, ctx) => {
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

export const pipelineSchema = z
  .object({
    /** Pipeline name. Must match the filename (without extension). */
    name: z.string().regex(/^[a-z][a-z0-9-]*$/, {
      message: 'Pipeline name must be lowercase, start with a letter, and contain only [a-z0-9-]',
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
    nodes: z.array(pipelineNode).min(1, 'Pipeline must declare at least one node'),
  })
  .strict()
  .superRefine((val, ctx) => {
    const ids = new Set<string>();
    for (const n of val.nodes) {
      if (ids.has(n.id)) {
        ctx.addIssue({ code: 'custom', message: `Duplicate node id: "${n.id}"` });
      }
      ids.add(n.id);
    }
    for (const n of val.nodes) {
      for (const dep of n.depends_on) {
        if (!ids.has(dep)) {
          ctx.addIssue({
            code: 'custom',
            message: `Node "${n.id}" depends_on unknown node "${dep}"`,
          });
        }
        if (dep === n.id) {
          ctx.addIssue({
            code: 'custom',
            message: `Node "${n.id}" cannot depend on itself`,
          });
        }
      }
      if (n.loop?.back_to && !ids.has(n.loop.back_to)) {
        ctx.addIssue({
          code: 'custom',
          message: `Node "${n.id}" loop.back_to references unknown node "${n.loop.back_to}"`,
        });
      }
    }
  });

// ── Inferred types ──────────────────────────────────────────

export type ParsedPipeline = z.infer<typeof pipelineSchema>;
export type ParsedNode = z.infer<typeof pipelineNode>;
export type ParsedInputDef = z.infer<typeof inputDef>;
export type ParsedRetry = z.infer<typeof retryConfig>;
export type ParsedLoop = z.infer<typeof loopConfig>;
