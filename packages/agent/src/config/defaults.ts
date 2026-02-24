/**
 * Default configuration values for the Agent Service.
 *
 * These values are used when no `.pipeline/config.yaml` is present,
 * or for any fields not explicitly overridden in the YAML.
 */

export const DEFAULT_CONFIG = {
  branch: {
    main: 'main',
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
