import { describe, it, expect } from 'bun:test';
import { PipelineServiceConfigSchema } from '../config/schema.js';

describe('PipelineServiceConfigSchema', () => {
  // ── Validates DEFAULT_CONFIG-equivalent successfully ─────────

  it('validates an empty object (all defaults applied)', () => {
    const result = PipelineServiceConfigSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('defaults have correct tier structure', () => {
    const config = PipelineServiceConfigSchema.parse({});
    expect(config.tiers.small).toBeDefined();
    expect(config.tiers.medium).toBeDefined();
    expect(config.tiers.large).toBeDefined();
  });

  it('defaults have correct branch config', () => {
    const config = PipelineServiceConfigSchema.parse({});
    expect(config.branch.pipeline_prefix).toBe('pipeline/');
    expect(config.branch.integration_prefix).toBe('integration/');
    expect(config.branch.main).toBe('main');
  });

  it('defaults have correct agent settings', () => {
    const config = PipelineServiceConfigSchema.parse({});
    expect(config.agents.conflict.model).toBe('opus');
    expect(config.agents.conflict.maxTurns).toBe(50);
    expect(config.agents.tests).toEqual({});
    expect(config.agents.security).toEqual({});
  });

  it('defaults have correct resilience settings', () => {
    const config = PipelineServiceConfigSchema.parse({});
    expect(config.resilience.circuit_breaker.claude.failure_threshold).toBe(3);
    expect(config.resilience.circuit_breaker.github.failure_threshold).toBe(5);
    expect(config.resilience.dlq.enabled).toBe(true);
    expect(config.resilience.dlq.max_retries).toBe(5);
  });

  it('defaults have correct director settings', () => {
    const config = PipelineServiceConfigSchema.parse({});
    expect(config.director.auto_trigger_delay_ms).toBe(500);
    expect(config.director.default_priority).toBe(10);
    expect(config.director.schedule_interval_ms).toBe(0);
  });

  // ── Validates a full config with all fields ─────────────────

  it('validates a full custom config', () => {
    const full = {
      tiers: {
        small: { max_files: 5, max_lines: 100, agents: ['tests'] },
        medium: { max_files: 15, max_lines: 500, agents: ['tests', 'security'] },
        large: { max_files: 100, max_lines: 5000, agents: ['tests', 'security', 'architecture'] },
      },
      branch: {
        pipeline_prefix: 'ci/',
        integration_prefix: 'int/',
        main: 'master',
      },
      agents: {
        conflict: { model: 'haiku', permissionMode: 'autoEdit', maxTurns: 30 },
        tests: { model: 'claude-sonnet', provider: 'funny-api-acp' },
      },
      auto_correction: { max_attempts: 5 },
      resilience: {
        circuit_breaker: {
          claude: { failure_threshold: 10, reset_timeout_ms: 30_000 },
          github: { failure_threshold: 3, reset_timeout_ms: 60_000 },
        },
        dlq: {
          enabled: false,
          path: '.ci/dlq',
          max_retries: 10,
          base_delay_ms: 1000,
          backoff_factor: 2,
        },
      },
      director: {
        auto_trigger_delay_ms: 1000,
        default_priority: 5,
        schedule_interval_ms: 300_000,
      },
      cleanup: {
        keep_on_failure: true,
        stale_branch_days: 14,
      },
      adapters: {
        webhooks: [],
        retry_interval_ms: 30_000,
      },
      events: { path: '/tmp/events' },
      logging: { level: 'debug' as const },
    };

    const result = PipelineServiceConfigSchema.safeParse(full);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.branch.main).toBe('master');
      expect(result.data.director.schedule_interval_ms).toBe(300_000);
    }
  });

  // ── Rejects invalid configurations ──────────────────────────

  it('rejects invalid agent name in tier agents list', () => {
    const result = PipelineServiceConfigSchema.safeParse({
      tiers: {
        small: { max_files: 3, max_lines: 50, agents: ['invalid_agent'] },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty agents array in a tier', () => {
    const result = PipelineServiceConfigSchema.safeParse({
      tiers: {
        small: { max_files: 3, max_lines: 50, agents: [] },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects max_files below minimum (0)', () => {
    const result = PipelineServiceConfigSchema.safeParse({
      tiers: {
        small: { max_files: 0, max_lines: 50, agents: ['tests'] },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects max_lines below minimum (0)', () => {
    const result = PipelineServiceConfigSchema.safeParse({
      tiers: {
        small: { max_files: 3, max_lines: 0, agents: ['tests'] },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects conflict maxTurns above 500', () => {
    const result = PipelineServiceConfigSchema.safeParse({
      agents: {
        conflict: { model: 'opus', permissionMode: 'autoEdit', maxTurns: 501 },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects conflict maxTurns below 1', () => {
    const result = PipelineServiceConfigSchema.safeParse({
      agents: {
        conflict: { model: 'opus', permissionMode: 'autoEdit', maxTurns: 0 },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid logging level', () => {
    const result = PipelineServiceConfigSchema.safeParse({
      logging: { level: 'verbose' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects webhook with invalid URL', () => {
    const result = PipelineServiceConfigSchema.safeParse({
      adapters: {
        webhooks: [{ url: 'not-a-url' }],
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects retry_interval_ms below 5000', () => {
    const result = PipelineServiceConfigSchema.safeParse({
      adapters: {
        retry_interval_ms: 1000,
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects stale_branch_days below 1', () => {
    const result = PipelineServiceConfigSchema.safeParse({
      cleanup: { stale_branch_days: 0 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects circuit breaker reset_timeout_ms below 1000', () => {
    const result = PipelineServiceConfigSchema.safeParse({
      resilience: {
        circuit_breaker: {
          claude: { failure_threshold: 3, reset_timeout_ms: 500 },
        },
      },
    });
    expect(result.success).toBe(false);
  });

  // ── Default values are applied for optional fields ──────────

  it('applies default logging level when logging omitted', () => {
    const config = PipelineServiceConfigSchema.parse({});
    expect(config.logging.level).toBe('info');
  });

  it('applies default webhook list when adapters omitted', () => {
    const config = PipelineServiceConfigSchema.parse({});
    expect(config.adapters.webhooks).toEqual([]);
    expect(config.adapters.retry_interval_ms).toBe(60_000);
  });

  it('applies default events path when events omitted', () => {
    const config = PipelineServiceConfigSchema.parse({});
    expect(config.events.path).toBeNull();
  });

  it('applies default cleanup settings when cleanup omitted', () => {
    const config = PipelineServiceConfigSchema.parse({});
    expect(config.cleanup.keep_on_failure).toBe(false);
    expect(config.cleanup.stale_branch_days).toBe(7);
  });

  it('applies default auto_correction when omitted', () => {
    const config = PipelineServiceConfigSchema.parse({});
    expect(config.auto_correction.max_attempts).toBe(2);
  });

  // ── Partial overrides keep other defaults ────────────────────

  it('partial branch override keeps other branch defaults', () => {
    const config = PipelineServiceConfigSchema.parse({
      branch: { main: 'master' },
    });
    expect(config.branch.main).toBe('master');
    expect(config.branch.pipeline_prefix).toBe('pipeline/');
    expect(config.branch.integration_prefix).toBe('integration/');
  });

  it('partial director override keeps other director defaults', () => {
    const config = PipelineServiceConfigSchema.parse({
      director: { schedule_interval_ms: 60_000 },
    });
    expect(config.director.schedule_interval_ms).toBe(60_000);
    expect(config.director.auto_trigger_delay_ms).toBe(500);
    expect(config.director.default_priority).toBe(10);
  });
});
