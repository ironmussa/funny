/**
 * Zod schema for the Pipeline Service configuration.
 *
 * Every field is optional with defaults matching DEFAULT_CONFIG.
 */

import { z } from 'zod';

const AgentNameSchema = z.enum([
  'tests', 'security', 'architecture', 'performance',
  'style', 'types', 'docs', 'integration', 'e2e',
]);

const TierConfigSchema = z.object({
  max_files: z.number().min(1).default(3),
  max_lines: z.number().min(1).default(50),
  agents: z.array(AgentNameSchema).min(1).default(['tests', 'style']),
});

const ConflictAgentSchema = z.object({
  model: z.string().default('opus'),
  permissionMode: z.string().default('autoEdit'),
  maxTurns: z.number().int().min(1).max(500).default(50),
});

const PerAgentOverrideSchema = z.object({
  model: z.string().optional(),
  provider: z.string().optional(),
  maxTurns: z.number().int().min(1).optional(),
}).default({});

const CircuitBreakerEntrySchema = z.object({
  failure_threshold: z.number().int().min(1).default(3),
  reset_timeout_ms: z.number().int().min(1000).default(60_000),
});

const DLQConfigSchema = z.object({
  enabled: z.boolean().default(true),
  path: z.string().default('.pipeline/dlq'),
  max_retries: z.number().int().min(1).default(5),
  base_delay_ms: z.number().int().min(100).default(5_000),
  backoff_factor: z.number().min(1).default(3),
});

export const PipelineServiceConfigSchema = z.object({
  tiers: z.object({
    small: TierConfigSchema.default({ max_files: 3, max_lines: 50, agents: ['tests', 'style'] }),
    medium: TierConfigSchema.default({ max_files: 10, max_lines: 300, agents: ['tests', 'security', 'architecture', 'style', 'types'] }),
    large: TierConfigSchema.default({ max_files: Infinity, max_lines: Infinity, agents: ['tests', 'security', 'architecture', 'performance', 'style', 'types', 'docs', 'integration'] }),
  }).default({}),

  branch: z.object({
    pipeline_prefix: z.string().default('pipeline/'),
    integration_prefix: z.string().default('integration/'),
    main: z.string().default('main'),
  }).default({}),

  agents: z.object({
    conflict: ConflictAgentSchema.default({ model: 'opus', permissionMode: 'autoEdit', maxTurns: 50 }),
    tests: PerAgentOverrideSchema,
    security: PerAgentOverrideSchema,
    architecture: PerAgentOverrideSchema,
    performance: PerAgentOverrideSchema,
    style: PerAgentOverrideSchema,
    types: PerAgentOverrideSchema,
    docs: PerAgentOverrideSchema,
    integration: PerAgentOverrideSchema,
    e2e: PerAgentOverrideSchema,
  }).default({}),

  auto_correction: z.object({
    max_attempts: z.number().int().min(0).default(2),
    backoff_base_ms: z.number().int().min(0).default(1000),
    backoff_factor: z.number().min(1).default(2),
  }).default({}),

  /** Maximum pipeline execution time in ms. 0 = no timeout (default). */
  pipeline_timeout_ms: z.number().int().min(0).default(0),

  resilience: z.object({
    circuit_breaker: z.object({
      claude: CircuitBreakerEntrySchema.default({ failure_threshold: 3, reset_timeout_ms: 60_000 }),
      github: CircuitBreakerEntrySchema.default({ failure_threshold: 5, reset_timeout_ms: 120_000 }),
    }).default({}),
    dlq: DLQConfigSchema.default({}),
  }).default({}),

  director: z.object({
    auto_trigger_delay_ms: z.number().int().min(0).default(500),
    default_priority: z.number().int().min(0).default(10),
    schedule_interval_ms: z.number().int().min(0).default(0),
  }).default({}),

  cleanup: z.object({
    keep_on_failure: z.boolean().default(false),
    stale_branch_days: z.number().int().min(1).default(7),
  }).default({}),

  adapters: z.object({
    webhooks: z.array(z.object({
      url: z.string().url(),
      secret: z.string().optional(),
      events: z.array(z.string()).optional(),
      timeout_ms: z.number().int().min(1000).default(10_000),
    })).default([]),
    retry_interval_ms: z.number().int().min(5_000).default(60_000),
  }).default({}),

  llm_providers: z.object({
    anthropic: z.object({
      api_key_env: z.string().default('ANTHROPIC_API_KEY'),
      base_url: z.string().default(''),
    }).default({}),
    funny_api_acp: z.object({
      api_key_env: z.string().default('FUNNY_API_ACP_KEY'),
      base_url: z.string().default('http://localhost:4010'),
    }).default({}),
    ollama: z.object({
      base_url: z.string().default('http://localhost:11434'),
    }).default({}),
    default_provider: z.string().default('funny-api-acp'),
    fallback_provider: z.string().optional(),
  }).default({}),

  webhook_secret: z.string().optional(),

  events: z.object({
    path: z.string().nullable().default(null),
  }).default({}),

  logging: z.object({
    level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  }).default({}),

  // ── Issue Tracker ──────────────────────────────────────────────

  tracker: z.object({
    type: z.enum(['github', 'linear']).default('github'),
    /** Owner/repo — auto-detected from git remote if not set */
    repo: z.string().optional(),
    /** Only pick up issues with these labels */
    labels: z.array(z.string()).default([]),
    /** Exclude issues with these labels */
    exclude_labels: z.array(z.string()).default(['wontfix', 'blocked']),
    /** Max concurrent sessions */
    max_parallel: z.number().int().min(1).default(5),
  }).default({}),

  // ── Orchestrator Agent ─────────────────────────────────────────

  orchestrator: z.object({
    model: z.string().default('claude-sonnet-4-5-20250929'),
    provider: z.string().default('funny-api-acp'),
    /** Auto-decompose complex issues into sub-tasks */
    auto_decompose: z.boolean().default(true),
    /** Require human approval of the plan before implementing */
    plan_approval: z.boolean().default(false),
    /** Max turns for the planning agent */
    max_planning_turns: z.number().int().min(1).default(30),
    /** Max turns for the implementing agent */
    max_implementing_turns: z.number().int().min(1).default(200),
  }).default({}),

  // ── Sessions ───────────────────────────────────────────────────

  sessions: z.object({
    /** Max CI fix attempts before escalating */
    max_retries_ci: z.number().int().min(0).default(3),
    /** Max review feedback cycles before escalating */
    max_retries_review: z.number().int().min(0).default(2),
    /** Minutes of inactivity before escalating a stuck session */
    escalate_after_min: z.number().int().min(0).default(30),
    /** Auto-merge when PR is approved and CI is green */
    auto_merge: z.boolean().default(false),
    /** Path for session persistence */
    persist_path: z.string().optional(),
  }).default({}),

  // ── Reactions ──────────────────────────────────────────────────

  reactions: z.object({
    ci_failed: z.object({
      action: z.enum(['respawn_agent', 'notify', 'escalate']).default('respawn_agent'),
      prompt: z.string().default('CI failed on this PR. Read the failure logs and fix the issues.'),
      max_retries: z.number().int().min(0).default(3),
    }).default({}),
    changes_requested: z.object({
      action: z.enum(['respawn_agent', 'notify', 'escalate']).default('respawn_agent'),
      prompt: z.string().default('Review comments have been posted. Address each comment and push fixes.'),
      max_retries: z.number().int().min(0).default(2),
      escalate_after_min: z.number().int().min(0).default(30),
    }).default({}),
    approved_and_green: z.object({
      action: z.enum(['notify', 'auto_merge']).default('notify'),
      message: z.string().default('PR approved and CI green — ready to merge'),
    }).default({}),
    agent_stuck: z.object({
      action: z.enum(['escalate', 'notify']).default('escalate'),
      after_min: z.number().int().min(1).default(15),
      message: z.string().default('Session stuck — needs human review'),
    }).default({}),
  }).default({}),
});

export type PipelineServiceConfig = z.infer<typeof PipelineServiceConfigSchema>;
