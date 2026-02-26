import { describe, it, expect } from 'bun:test';

import { PipelineServiceConfigSchema } from '../config/schema.js';

describe('PipelineServiceConfigSchema', () => {
  // ── Validates defaults ────────────────────────────────────────

  it('validates an empty object (all defaults applied)', () => {
    const result = PipelineServiceConfigSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('defaults have correct branch config', () => {
    const config = PipelineServiceConfigSchema.parse({});
    expect(config.branch.main).toBe('main');
  });

  it('defaults have correct LLM provider config', () => {
    const config = PipelineServiceConfigSchema.parse({});
    expect(config.llm_providers.default_provider).toBe('funny-api-acp');
    expect(config.llm_providers.anthropic.api_key_env).toBe('ANTHROPIC_API_KEY');
    expect(config.llm_providers.ollama.base_url).toBe('http://localhost:11434');
  });

  it('defaults have correct orchestrator config', () => {
    const config = PipelineServiceConfigSchema.parse({});
    expect(config.orchestrator.model).toBe('claude-sonnet-4-5-20250929');
    expect(config.orchestrator.provider).toBe('funny-api-acp');
    expect(config.orchestrator.auto_decompose).toBe(true);
    expect(config.orchestrator.plan_approval).toBe(false);
  });

  it('defaults have correct session config', () => {
    const config = PipelineServiceConfigSchema.parse({});
    expect(config.sessions.max_retries_ci).toBe(3);
    expect(config.sessions.max_retries_review).toBe(2);
    expect(config.sessions.auto_merge).toBe(false);
  });

  it('defaults have correct reaction config', () => {
    const config = PipelineServiceConfigSchema.parse({});
    expect(config.reactions.ci_failed.action).toBe('respawn_agent');
    expect(config.reactions.changes_requested.action).toBe('respawn_agent');
    expect(config.reactions.approved_and_green.action).toBe('notify');
    expect(config.reactions.agent_stuck.action).toBe('escalate');
  });

  it('defaults have correct tracker config', () => {
    const config = PipelineServiceConfigSchema.parse({});
    expect(config.tracker.type).toBe('github');
    expect(config.tracker.max_parallel).toBe(5);
    expect(config.tracker.labels).toEqual([]);
    expect(config.tracker.exclude_labels).toEqual(['wontfix', 'blocked']);
  });

  // ── Validates a full custom config ───────────────────────────

  it('validates a full custom config', () => {
    const full = {
      branch: { main: 'master' },
      llm_providers: {
        anthropic: { api_key_env: 'MY_KEY', base_url: 'https://api.example.com' },
        default_provider: 'anthropic',
      },
      events: { path: '/tmp/events' },
      logging: { level: 'debug' as const },
      tracker: { type: 'github' as const, repo: 'org/repo', max_parallel: 3 },
      orchestrator: {
        model: 'claude-opus-4-6',
        provider: 'anthropic',
        auto_decompose: false,
        plan_approval: true,
        max_planning_turns: 50,
        max_implementing_turns: 100,
      },
      sessions: {
        max_retries_ci: 5,
        max_retries_review: 3,
        escalate_after_min: 60,
        auto_merge: true,
      },
      reactions: {
        ci_failed: { action: 'notify' as const, prompt: 'CI broke', max_retries: 1 },
        approved_and_green: { action: 'auto_merge' as const },
      },
    };

    const result = PipelineServiceConfigSchema.safeParse(full);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.branch.main).toBe('master');
      expect(result.data.orchestrator.plan_approval).toBe(true);
      expect(result.data.sessions.auto_merge).toBe(true);
    }
  });

  // ── Rejects invalid configurations ───────────────────────────

  it('rejects invalid logging level', () => {
    const result = PipelineServiceConfigSchema.safeParse({
      logging: { level: 'verbose' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects max_parallel below 1', () => {
    const result = PipelineServiceConfigSchema.safeParse({
      tracker: { max_parallel: 0 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects max_planning_turns below 1', () => {
    const result = PipelineServiceConfigSchema.safeParse({
      orchestrator: { max_planning_turns: 0 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects negative max_retries_ci', () => {
    const result = PipelineServiceConfigSchema.safeParse({
      sessions: { max_retries_ci: -1 },
    });
    expect(result.success).toBe(false);
  });

  // ── Default values are applied for optional fields ───────────

  it('applies default logging level when logging omitted', () => {
    const config = PipelineServiceConfigSchema.parse({});
    expect(config.logging.level).toBe('info');
  });

  it('applies default events path when events omitted', () => {
    const config = PipelineServiceConfigSchema.parse({});
    expect(config.events.path).toBeNull();
  });

  // ── Partial overrides keep other defaults ─────────────────────

  it('partial branch override keeps defaults for other fields', () => {
    const config = PipelineServiceConfigSchema.parse({
      branch: { main: 'master' },
    });
    expect(config.branch.main).toBe('master');
    // Other sections still have defaults
    expect(config.logging.level).toBe('info');
    expect(config.orchestrator.model).toBe('claude-sonnet-4-5-20250929');
  });

  it('partial sessions override keeps other session defaults', () => {
    const config = PipelineServiceConfigSchema.parse({
      sessions: { auto_merge: true },
    });
    expect(config.sessions.auto_merge).toBe(true);
    expect(config.sessions.max_retries_ci).toBe(3);
    expect(config.sessions.max_retries_review).toBe(2);
  });
});
