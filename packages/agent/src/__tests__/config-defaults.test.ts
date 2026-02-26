import { describe, it, expect } from 'bun:test';

import { DEFAULT_CONFIG } from '../config/defaults.js';

describe('DEFAULT_CONFIG', () => {
  // ── Required top-level keys ──────────────────────────────────

  it('has all required top-level keys', () => {
    const requiredKeys = [
      'branch',
      'llm_providers',
      'events',
      'logging',
      'tracker',
      'orchestrator',
      'sessions',
      'reactions',
    ];
    for (const key of requiredKeys) {
      expect(DEFAULT_CONFIG).toHaveProperty(key);
    }
  });

  // ── Branch ────────────────────────────────────────────────────

  it('main branch defaults to "main"', () => {
    expect(DEFAULT_CONFIG.branch.main).toBe('main');
  });

  // ── LLM Providers ────────────────────────────────────────────

  it('has anthropic, funny_api_acp, and ollama providers', () => {
    expect(DEFAULT_CONFIG.llm_providers.anthropic).toBeDefined();
    expect(DEFAULT_CONFIG.llm_providers.funny_api_acp).toBeDefined();
    expect(DEFAULT_CONFIG.llm_providers.ollama).toBeDefined();
  });

  it('default provider is funny-api-acp', () => {
    expect(DEFAULT_CONFIG.llm_providers.default_provider).toBe('funny-api-acp');
  });

  // ── Tracker ──────────────────────────────────────────────────

  it('tracker defaults to github type', () => {
    expect(DEFAULT_CONFIG.tracker.type).toBe('github');
  });

  it('tracker max_parallel defaults to 5', () => {
    expect(DEFAULT_CONFIG.tracker.max_parallel).toBe(5);
  });

  // ── Orchestrator ─────────────────────────────────────────────

  it('orchestrator has model and provider', () => {
    expect(DEFAULT_CONFIG.orchestrator.model).toBeTruthy();
    expect(DEFAULT_CONFIG.orchestrator.provider).toBeTruthy();
  });

  it('orchestrator has planning and implementing turn limits', () => {
    expect(DEFAULT_CONFIG.orchestrator.max_planning_turns).toBeGreaterThan(0);
    expect(DEFAULT_CONFIG.orchestrator.max_implementing_turns).toBeGreaterThan(0);
  });

  // ── Sessions ─────────────────────────────────────────────────

  it('sessions have retry limits', () => {
    expect(DEFAULT_CONFIG.sessions.max_retries_ci).toBeGreaterThan(0);
    expect(DEFAULT_CONFIG.sessions.max_retries_review).toBeGreaterThan(0);
  });

  it('auto_merge defaults to false', () => {
    expect(DEFAULT_CONFIG.sessions.auto_merge).toBe(false);
  });

  // ── Reactions ────────────────────────────────────────────────

  it('ci_failed reaction defaults to respawn_agent', () => {
    expect(DEFAULT_CONFIG.reactions.ci_failed.action).toBe('respawn_agent');
  });

  it('changes_requested reaction defaults to respawn_agent', () => {
    expect(DEFAULT_CONFIG.reactions.changes_requested.action).toBe('respawn_agent');
  });

  it('approved_and_green reaction defaults to notify', () => {
    expect(DEFAULT_CONFIG.reactions.approved_and_green.action).toBe('notify');
  });

  it('agent_stuck reaction defaults to escalate', () => {
    expect(DEFAULT_CONFIG.reactions.agent_stuck.action).toBe('escalate');
  });

  // ── Logging ──────────────────────────────────────────────────

  it('logging level defaults to "info"', () => {
    expect(DEFAULT_CONFIG.logging.level).toBe('info');
  });
});
