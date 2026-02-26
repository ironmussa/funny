/**
 * Zod schema for the Agent Service configuration.
 *
 * Every field is optional with defaults matching DEFAULT_CONFIG.
 */

import { z } from 'zod';

export const PipelineServiceConfigSchema = z.object({
  branch: z
    .object({
      main: z.string().default('main'),
    })
    .default({}),

  llm_providers: z
    .object({
      anthropic: z
        .object({
          api_key_env: z.string().default('ANTHROPIC_API_KEY'),
          base_url: z.string().default(''),
        })
        .default({}),
      funny_api_acp: z
        .object({
          api_key_env: z.string().default('FUNNY_API_ACP_KEY'),
          base_url: z.string().default('http://localhost:4010'),
        })
        .default({}),
      ollama: z
        .object({
          base_url: z.string().default('http://localhost:11434'),
        })
        .default({}),
      default_provider: z.string().default('funny-api-acp'),
      fallback_provider: z.string().optional(),
    })
    .default({}),

  webhook_secret: z.string().optional(),

  events: z
    .object({
      path: z.string().nullable().default(null),
    })
    .default({}),

  logging: z
    .object({
      level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    })
    .default({}),

  // ── Issue Tracker ──────────────────────────────────────────────

  tracker: z
    .object({
      type: z.enum(['github', 'linear']).default('github'),
      /** Owner/repo — auto-detected from git remote if not set */
      repo: z.string().optional(),
      /** Only pick up issues with these labels */
      labels: z.array(z.string()).default([]),
      /** Exclude issues with these labels */
      exclude_labels: z.array(z.string()).default(['wontfix', 'blocked']),
      /** Max concurrent sessions */
      max_parallel: z.number().int().min(1).default(5),
    })
    .default({}),

  // ── Orchestrator Agent ─────────────────────────────────────────

  orchestrator: z
    .object({
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
    })
    .default({}),

  // ── Sessions ───────────────────────────────────────────────────

  sessions: z
    .object({
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
    })
    .default({}),

  // ── Reactions ──────────────────────────────────────────────────

  reactions: z
    .object({
      ci_failed: z
        .object({
          action: z.enum(['respawn_agent', 'notify', 'escalate']).default('respawn_agent'),
          prompt: z
            .string()
            .default('CI failed on this PR. Read the failure logs and fix the issues.'),
          max_retries: z.number().int().min(0).default(3),
        })
        .default({}),
      changes_requested: z
        .object({
          action: z.enum(['respawn_agent', 'notify', 'escalate']).default('respawn_agent'),
          prompt: z
            .string()
            .default('Review comments have been posted. Address each comment and push fixes.'),
          max_retries: z.number().int().min(0).default(2),
          escalate_after_min: z.number().int().min(0).default(30),
        })
        .default({}),
      approved_and_green: z
        .object({
          action: z.enum(['notify', 'auto_merge']).default('notify'),
          message: z.string().default('PR approved and CI green — ready to merge'),
        })
        .default({}),
      agent_stuck: z
        .object({
          action: z.enum(['escalate', 'notify']).default('escalate'),
          after_min: z.number().int().min(1).default(15),
          message: z.string().default('Session stuck — needs human review'),
        })
        .default({}),
    })
    .default({}),
});

export type PipelineServiceConfig = z.infer<typeof PipelineServiceConfigSchema>;
