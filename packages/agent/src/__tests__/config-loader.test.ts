import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';

import { loadConfig } from '../config/loader.js';

const TEST_DIR = join(import.meta.dir, '..', '..', '.test-tmp-config-loader');

beforeEach(() => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
});

describe('loadConfig', () => {
  // ── Returns defaults when no config file exists ─────────────

  it('returns defaults when no .pipeline/config.yaml exists', async () => {
    const config = await loadConfig(TEST_DIR);

    expect(config.branch.main).toBe('main');
    expect(config.logging.level).toBe('info');
    expect(config.orchestrator.model).toBe('claude-sonnet-4-5-20250929');
    expect(config.sessions.max_retries_ci).toBe(3);
    expect(config.reactions.ci_failed.action).toBe('respawn_agent');
  });

  it('returns all expected top-level keys in defaults', async () => {
    const config = await loadConfig(TEST_DIR);

    expect(config).toHaveProperty('branch');
    expect(config).toHaveProperty('llm_providers');
    expect(config).toHaveProperty('events');
    expect(config).toHaveProperty('logging');
    expect(config).toHaveProperty('tracker');
    expect(config).toHaveProperty('orchestrator');
    expect(config).toHaveProperty('sessions');
    expect(config).toHaveProperty('reactions');
  });

  // ── Parses YAML config ──────────────────────────────────────

  it('parses a valid YAML config file', async () => {
    const pipelineDir = join(TEST_DIR, '.pipeline');
    mkdirSync(pipelineDir, { recursive: true });

    const yaml = `
branch:
  main: master

orchestrator:
  plan_approval: true

logging:
  level: debug
`;
    await Bun.write(join(pipelineDir, 'config.yaml'), yaml);

    const config = await loadConfig(TEST_DIR);

    expect(config.branch.main).toBe('master');
    expect(config.orchestrator.plan_approval).toBe(true);
    expect(config.logging.level).toBe('debug');
  });

  it('overrides session configuration from YAML', async () => {
    const pipelineDir = join(TEST_DIR, '.pipeline');
    mkdirSync(pipelineDir, { recursive: true });

    const yaml = `
sessions:
  max_retries_ci: 5
  auto_merge: true
`;
    await Bun.write(join(pipelineDir, 'config.yaml'), yaml);

    const config = await loadConfig(TEST_DIR);

    expect(config.sessions.max_retries_ci).toBe(5);
    expect(config.sessions.auto_merge).toBe(true);
  });

  // ── Resolves environment variables ──────────────────────────

  it('resolves ${VAR} patterns in string values', async () => {
    const pipelineDir = join(TEST_DIR, '.pipeline');
    mkdirSync(pipelineDir, { recursive: true });

    const originalValue = process.env.TEST_MAIN_BRANCH;
    process.env.TEST_MAIN_BRANCH = 'develop';

    try {
      const yaml = `
branch:
  main: "\${TEST_MAIN_BRANCH}"
`;
      await Bun.write(join(pipelineDir, 'config.yaml'), yaml);

      const config = await loadConfig(TEST_DIR);
      expect(config.branch.main).toBe('develop');
    } finally {
      if (originalValue === undefined) {
        delete process.env.TEST_MAIN_BRANCH;
      } else {
        process.env.TEST_MAIN_BRANCH = originalValue;
      }
    }
  });

  // ── Falls back to defaults on parse error ───────────────────

  it('falls back to defaults on invalid YAML', async () => {
    const pipelineDir = join(TEST_DIR, '.pipeline');
    mkdirSync(pipelineDir, { recursive: true });

    await Bun.write(join(pipelineDir, 'config.yaml'), '{{{{ invalid: yaml ::::');

    const config = await loadConfig(TEST_DIR);

    expect(config.branch.main).toBe('main');
    expect(config.logging.level).toBe('info');
  });

  // ── Partial config merges with defaults ─────────────────────

  it('partial config gets merged with defaults for unspecified fields', async () => {
    const pipelineDir = join(TEST_DIR, '.pipeline');
    mkdirSync(pipelineDir, { recursive: true });

    const yaml = `
logging:
  level: warn
`;
    await Bun.write(join(pipelineDir, 'config.yaml'), yaml);

    const config = await loadConfig(TEST_DIR);

    // Overridden value
    expect(config.logging.level).toBe('warn');
    // Default values for everything else
    expect(config.branch.main).toBe('main');
    expect(config.orchestrator.model).toBe('claude-sonnet-4-5-20250929');
    expect(config.sessions.max_retries_ci).toBe(3);
  });

  it('empty YAML file returns all defaults', async () => {
    const pipelineDir = join(TEST_DIR, '.pipeline');
    mkdirSync(pipelineDir, { recursive: true });

    await Bun.write(join(pipelineDir, 'config.yaml'), '');

    const config = await loadConfig(TEST_DIR);

    expect(config.branch.main).toBe('main');
    expect(config.logging.level).toBe('info');
  });
});
