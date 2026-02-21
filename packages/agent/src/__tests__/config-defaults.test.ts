import { describe, it, expect } from 'bun:test';
import { DEFAULT_CONFIG } from '../config/defaults.js';

describe('DEFAULT_CONFIG', () => {
  // ── Required top-level keys ──────────────────────────────────

  it('has all required top-level keys', () => {
    const requiredKeys = [
      'tiers',
      'branch',
      'agents',
      'auto_correction',
      'resilience',
      'director',
      'cleanup',
      'adapters',
      'webhook_secret',
      'events',
      'logging',
    ];
    for (const key of requiredKeys) {
      expect(DEFAULT_CONFIG).toHaveProperty(key);
    }
  });

  // ── Tier thresholds are reasonable ──────────────────────────

  it('tier thresholds: small < medium < large for max_files', () => {
    expect(DEFAULT_CONFIG.tiers.small.max_files).toBeLessThan(DEFAULT_CONFIG.tiers.medium.max_files);
    expect(DEFAULT_CONFIG.tiers.medium.max_files).toBeLessThan(DEFAULT_CONFIG.tiers.large.max_files);
  });

  it('tier thresholds: small < medium < large for max_lines', () => {
    expect(DEFAULT_CONFIG.tiers.small.max_lines).toBeLessThan(DEFAULT_CONFIG.tiers.medium.max_lines);
    expect(DEFAULT_CONFIG.tiers.medium.max_lines).toBeLessThan(DEFAULT_CONFIG.tiers.large.max_lines);
  });

  it('small tier has positive thresholds', () => {
    expect(DEFAULT_CONFIG.tiers.small.max_files).toBeGreaterThan(0);
    expect(DEFAULT_CONFIG.tiers.small.max_lines).toBeGreaterThan(0);
  });

  it('large tier uses Infinity for both thresholds', () => {
    expect(DEFAULT_CONFIG.tiers.large.max_files).toBe(Infinity);
    expect(DEFAULT_CONFIG.tiers.large.max_lines).toBe(Infinity);
  });

  // ── Agent lists are non-empty for each tier ─────────────────

  it('small tier has non-empty agent list', () => {
    expect(DEFAULT_CONFIG.tiers.small.agents.length).toBeGreaterThan(0);
  });

  it('medium tier has non-empty agent list', () => {
    expect(DEFAULT_CONFIG.tiers.medium.agents.length).toBeGreaterThan(0);
  });

  it('large tier has non-empty agent list', () => {
    expect(DEFAULT_CONFIG.tiers.large.agents.length).toBeGreaterThan(0);
  });

  it('larger tiers have more agents than smaller tiers', () => {
    expect(DEFAULT_CONFIG.tiers.medium.agents.length).toBeGreaterThanOrEqual(
      DEFAULT_CONFIG.tiers.small.agents.length,
    );
    expect(DEFAULT_CONFIG.tiers.large.agents.length).toBeGreaterThanOrEqual(
      DEFAULT_CONFIG.tiers.medium.agents.length,
    );
  });

  it('all tier agents are valid agent names', () => {
    const validNames = ['tests', 'security', 'architecture', 'performance', 'style', 'types', 'docs', 'integration'];
    for (const tier of ['small', 'medium', 'large'] as const) {
      for (const agent of DEFAULT_CONFIG.tiers[tier].agents) {
        expect(validNames).toContain(agent);
      }
    }
  });

  // ── Branch prefixes ─────────────────────────────────────────

  it('branch prefixes are set and non-empty', () => {
    expect(DEFAULT_CONFIG.branch.pipeline_prefix).toBeTruthy();
    expect(DEFAULT_CONFIG.branch.integration_prefix).toBeTruthy();
    expect(DEFAULT_CONFIG.branch.main).toBeTruthy();
  });

  it('pipeline prefix ends with /', () => {
    expect(DEFAULT_CONFIG.branch.pipeline_prefix.endsWith('/')).toBe(true);
  });

  it('integration prefix ends with /', () => {
    expect(DEFAULT_CONFIG.branch.integration_prefix.endsWith('/')).toBe(true);
  });

  it('main branch defaults to "main"', () => {
    expect(DEFAULT_CONFIG.branch.main).toBe('main');
  });

  // ── Resilience defaults ─────────────────────────────────────

  it('circuit breaker config exists for claude and github', () => {
    expect(DEFAULT_CONFIG.resilience.circuit_breaker).toHaveProperty('claude');
    expect(DEFAULT_CONFIG.resilience.circuit_breaker).toHaveProperty('github');
  });

  it('claude circuit breaker has positive failure_threshold and reset_timeout_ms', () => {
    expect(DEFAULT_CONFIG.resilience.circuit_breaker.claude.failure_threshold).toBeGreaterThan(0);
    expect(DEFAULT_CONFIG.resilience.circuit_breaker.claude.reset_timeout_ms).toBeGreaterThan(0);
  });

  it('github circuit breaker has positive failure_threshold and reset_timeout_ms', () => {
    expect(DEFAULT_CONFIG.resilience.circuit_breaker.github.failure_threshold).toBeGreaterThan(0);
    expect(DEFAULT_CONFIG.resilience.circuit_breaker.github.reset_timeout_ms).toBeGreaterThan(0);
  });

  it('DLQ config has all required fields', () => {
    const dlq = DEFAULT_CONFIG.resilience.dlq;
    expect(dlq.enabled).toBe(true);
    expect(dlq.path).toBeTruthy();
    expect(dlq.max_retries).toBeGreaterThan(0);
    expect(dlq.base_delay_ms).toBeGreaterThan(0);
    expect(dlq.backoff_factor).toBeGreaterThanOrEqual(1);
  });

  // ── Director defaults ───────────────────────────────────────

  it('director defaults exist with required fields', () => {
    expect(DEFAULT_CONFIG.director).toHaveProperty('auto_trigger_delay_ms');
    expect(DEFAULT_CONFIG.director).toHaveProperty('default_priority');
    expect(DEFAULT_CONFIG.director).toHaveProperty('schedule_interval_ms');
  });

  it('director auto_trigger_delay_ms is non-negative', () => {
    expect(DEFAULT_CONFIG.director.auto_trigger_delay_ms).toBeGreaterThanOrEqual(0);
  });

  it('director default_priority is positive', () => {
    expect(DEFAULT_CONFIG.director.default_priority).toBeGreaterThan(0);
  });

  it('director schedule_interval_ms defaults to 0 (disabled)', () => {
    expect(DEFAULT_CONFIG.director.schedule_interval_ms).toBe(0);
  });

  // ── Agent settings ──────────────────────────────────────────

  it('agents config has conflict and per-agent overrides', () => {
    expect(DEFAULT_CONFIG.agents).toHaveProperty('conflict');
    expect(DEFAULT_CONFIG.agents).toHaveProperty('tests');
    expect(DEFAULT_CONFIG.agents).toHaveProperty('security');
  });

  it('conflict agent has model, permissionMode, and maxTurns', () => {
    expect(DEFAULT_CONFIG.agents.conflict.model).toBeTruthy();
    expect(DEFAULT_CONFIG.agents.conflict.permissionMode).toBeTruthy();
    expect(DEFAULT_CONFIG.agents.conflict.maxTurns).toBeGreaterThan(0);
  });

  it('per-agent overrides default to empty objects', () => {
    expect(DEFAULT_CONFIG.agents.tests).toEqual({});
    expect(DEFAULT_CONFIG.agents.security).toEqual({});
  });

  // ── Cleanup defaults ────────────────────────────────────────

  it('cleanup defaults exist', () => {
    expect(DEFAULT_CONFIG.cleanup).toHaveProperty('keep_on_failure');
    expect(DEFAULT_CONFIG.cleanup).toHaveProperty('stale_branch_days');
    expect(DEFAULT_CONFIG.cleanup.stale_branch_days).toBeGreaterThan(0);
  });

  // ── Logging defaults ────────────────────────────────────────

  it('logging level defaults to "info"', () => {
    expect(DEFAULT_CONFIG.logging.level).toBe('info');
  });
});
