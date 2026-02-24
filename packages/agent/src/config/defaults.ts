/**
 * Default configuration values for the Pipeline Service.
 *
 * These values are used when no `.pipeline/config.yaml` is present,
 * or for any fields not explicitly overridden in the YAML.
 */

import type { AgentName } from '../core/types.js';

export const DEFAULT_CONFIG = {
  tiers: {
    small: {
      max_files: 3,
      max_lines: 50,
      agents: ['tests', 'style'] as AgentName[],
    },
    medium: {
      max_files: 10,
      max_lines: 300,
      agents: ['tests', 'security', 'architecture', 'style', 'types'] as AgentName[],
    },
    large: {
      max_files: Infinity,
      max_lines: Infinity,
      agents: [
        'tests', 'security', 'architecture', 'performance',
        'style', 'types', 'docs', 'integration',
      ] as AgentName[],
    },
  },

  branch: {
    pipeline_prefix: 'pipeline/',
    integration_prefix: 'integration/',
    main: 'main',
  },

  agents: {
    conflict: { model: 'opus', permissionMode: 'autoEdit', maxTurns: 50 },
    tests: {} as { model?: string; provider?: string; maxTurns?: number },
    security: {} as { model?: string; provider?: string; maxTurns?: number },
    architecture: {} as { model?: string; provider?: string; maxTurns?: number },
    performance: {} as { model?: string; provider?: string; maxTurns?: number },
    style: {} as { model?: string; provider?: string; maxTurns?: number },
    types: {} as { model?: string; provider?: string; maxTurns?: number },
    docs: {} as { model?: string; provider?: string; maxTurns?: number },
    integration: {} as { model?: string; provider?: string; maxTurns?: number },
  },

  auto_correction: {
    max_attempts: 2,
    backoff_base_ms: 1000,
    backoff_factor: 2,
  },

  pipeline_timeout_ms: 0,  // 0 = no timeout

  resilience: {
    circuit_breaker: {
      claude: { failure_threshold: 3, reset_timeout_ms: 60_000 },
      github: { failure_threshold: 5, reset_timeout_ms: 120_000 },
    },
    dlq: {
      enabled: true,
      path: '.pipeline/dlq',
      max_retries: 5,
      base_delay_ms: 5_000,
      backoff_factor: 3,
    },
  },

  director: {
    auto_trigger_delay_ms: 500,
    default_priority: 10,
    schedule_interval_ms: 0,  // 0 = disabled; e.g. 300_000 for every 5 min
  },

  cleanup: {
    keep_on_failure: false,
    stale_branch_days: 7,
  },

  adapters: {
    webhooks: [] as Array<{ url: string; secret?: string; events?: string[]; timeout_ms?: number }>,
    retry_interval_ms: 60_000,
  },

  llm_providers: {
    anthropic: {
      api_key_env: 'ANTHROPIC_API_KEY',
      base_url: '',
    },
    funny_api_acp: {
      api_key_env: 'FUNNY_API_ACP_KEY',
      base_url: 'http://localhost:4010',
    },
    ollama: {
      base_url: 'http://localhost:11434',
    },
    default_provider: 'funny-api-acp',
    fallback_provider: undefined as string | undefined,
  },

  webhook_secret: undefined as string | undefined,

  events: {
    path: null as string | null,
  },

  logging: {
    level: 'info',
  },

  tracker: {
    type: 'github' as const,
    repo: undefined as string | undefined,
    labels: [] as string[],
    exclude_labels: ['wontfix', 'blocked'] as string[],
    max_parallel: 5,
  },

  orchestrator: {
    model: 'claude-sonnet-4-5-20250929',
    provider: 'funny-api-acp',
    auto_decompose: true,
    plan_approval: false,
    max_planning_turns: 30,
    max_implementing_turns: 200,
  },

  sessions: {
    max_retries_ci: 3,
    max_retries_review: 2,
    escalate_after_min: 30,
    auto_merge: false,
    persist_path: undefined as string | undefined,
  },

  reactions: {
    ci_failed: {
      action: 'respawn_agent' as const,
      prompt: 'CI failed on this PR. Read the failure logs and fix the issues.',
      max_retries: 3,
    },
    changes_requested: {
      action: 'respawn_agent' as const,
      prompt: 'Review comments have been posted. Address each comment and push fixes.',
      max_retries: 2,
      escalate_after_min: 30,
    },
    approved_and_green: {
      action: 'notify' as const,
      message: 'PR approved and CI green — ready to merge',
    },
    agent_stuck: {
      action: 'escalate' as const,
      after_min: 15,
      message: 'Session stuck — needs human review',
    },
  },
} as const;
