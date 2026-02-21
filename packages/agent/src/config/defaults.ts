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
  },

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
      base_url: 'https://api.anthropic.com',
    },
    openai: {
      api_key_env: 'OPENAI_API_KEY',
      base_url: 'https://api.openai.com',
    },
    ollama: {
      base_url: 'http://localhost:11434',
    },
    default_provider: 'anthropic',
    fallback_provider: undefined as string | undefined,
  },

  webhook_secret: undefined as string | undefined,

  events: {
    path: null as string | null,
  },

  logging: {
    level: 'info',
  },
} as const;
