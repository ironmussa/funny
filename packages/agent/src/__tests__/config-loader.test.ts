import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { loadConfig } from '../config/loader.js';
import { join } from 'path';
import { mkdirSync, rmSync, existsSync } from 'fs';

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

    expect(config.branch.pipeline_prefix).toBe('pipeline/');
    expect(config.branch.integration_prefix).toBe('integration/');
    expect(config.branch.main).toBe('main');
    expect(config.tiers.small.max_files).toBe(3);
    expect(config.tiers.small.max_lines).toBe(50);
    expect(config.agents.conflict.model).toBe('opus');
    expect(config.director.auto_trigger_delay_ms).toBe(500);
    expect(config.resilience.dlq.enabled).toBe(true);
    expect(config.logging.level).toBe('info');
  });

  it('returns all expected top-level keys in defaults', async () => {
    const config = await loadConfig(TEST_DIR);

    expect(config).toHaveProperty('tiers');
    expect(config).toHaveProperty('branch');
    expect(config).toHaveProperty('agents');
    expect(config).toHaveProperty('auto_correction');
    expect(config).toHaveProperty('resilience');
    expect(config).toHaveProperty('director');
    expect(config).toHaveProperty('cleanup');
    expect(config).toHaveProperty('adapters');
    expect(config).toHaveProperty('events');
    expect(config).toHaveProperty('logging');
  });

  // ── Parses YAML config ──────────────────────────────────────

  it('parses a valid YAML config file', async () => {
    const pipelineDir = join(TEST_DIR, '.pipeline');
    mkdirSync(pipelineDir, { recursive: true });

    const yaml = `
branch:
  main: master
  pipeline_prefix: ci/

director:
  schedule_interval_ms: 300000

logging:
  level: debug
`;
    await Bun.write(join(pipelineDir, 'config.yaml'), yaml);

    const config = await loadConfig(TEST_DIR);

    expect(config.branch.main).toBe('master');
    expect(config.branch.pipeline_prefix).toBe('ci/');
    // Default still applied for non-specified fields
    expect(config.branch.integration_prefix).toBe('integration/');
    expect(config.director.schedule_interval_ms).toBe(300_000);
    expect(config.logging.level).toBe('debug');
  });

  it('overrides tier configuration from YAML', async () => {
    const pipelineDir = join(TEST_DIR, '.pipeline');
    mkdirSync(pipelineDir, { recursive: true });

    const yaml = `
tiers:
  small:
    max_files: 5
    max_lines: 100
    agents:
      - tests
      - security
`;
    await Bun.write(join(pipelineDir, 'config.yaml'), yaml);

    const config = await loadConfig(TEST_DIR);

    expect(config.tiers.small.max_files).toBe(5);
    expect(config.tiers.small.max_lines).toBe(100);
    expect(config.tiers.small.agents).toEqual(['tests', 'security']);
  });

  it('overrides resilience DLQ settings from YAML', async () => {
    const pipelineDir = join(TEST_DIR, '.pipeline');
    mkdirSync(pipelineDir, { recursive: true });

    const yaml = `
resilience:
  dlq:
    enabled: false
    max_retries: 10
`;
    await Bun.write(join(pipelineDir, 'config.yaml'), yaml);

    const config = await loadConfig(TEST_DIR);

    expect(config.resilience.dlq.enabled).toBe(false);
    expect(config.resilience.dlq.max_retries).toBe(10);
  });

  // ── Resolves environment variables ──────────────────────────

  it('resolves ${VAR} patterns in string values', async () => {
    const pipelineDir = join(TEST_DIR, '.pipeline');
    mkdirSync(pipelineDir, { recursive: true });

    // Set env var for the test
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
      // Restore original env
      if (originalValue === undefined) {
        delete process.env.TEST_MAIN_BRANCH;
      } else {
        process.env.TEST_MAIN_BRANCH = originalValue;
      }
    }
  });

  it('resolves unset env vars to empty string', async () => {
    const pipelineDir = join(TEST_DIR, '.pipeline');
    mkdirSync(pipelineDir, { recursive: true });

    // Make sure this env var does not exist
    delete process.env.DEFINITELY_NOT_SET_XYZ_123;

    const yaml = `
branch:
  pipeline_prefix: "\${DEFINITELY_NOT_SET_XYZ_123}prefix/"
`;
    await Bun.write(join(pipelineDir, 'config.yaml'), yaml);

    const config = await loadConfig(TEST_DIR);
    expect(config.branch.pipeline_prefix).toBe('prefix/');
  });

  // ── Falls back to defaults on parse error ───────────────────

  it('falls back to defaults on invalid YAML', async () => {
    const pipelineDir = join(TEST_DIR, '.pipeline');
    mkdirSync(pipelineDir, { recursive: true });

    // Write completely broken YAML
    await Bun.write(join(pipelineDir, 'config.yaml'), '{{{{ invalid: yaml ::::');

    const config = await loadConfig(TEST_DIR);

    // Should get defaults since parsing failed
    expect(config.branch.main).toBe('main');
    expect(config.branch.pipeline_prefix).toBe('pipeline/');
    expect(config.logging.level).toBe('info');
  });

  it('falls back to defaults when YAML has invalid schema values', async () => {
    const pipelineDir = join(TEST_DIR, '.pipeline');
    mkdirSync(pipelineDir, { recursive: true });

    // Write valid YAML but with values that fail schema validation
    const yaml = `
tiers:
  small:
    max_files: 0
    max_lines: -1
    agents: []
`;
    await Bun.write(join(pipelineDir, 'config.yaml'), yaml);

    const config = await loadConfig(TEST_DIR);

    // Should fall back to defaults since schema validation fails
    expect(config.tiers.small.max_files).toBe(3);
    expect(config.tiers.small.max_lines).toBe(50);
    expect(config.tiers.small.agents).toEqual(['tests', 'style']);
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
    expect(config.tiers.small.max_files).toBe(3);
    expect(config.agents.conflict.model).toBe('opus');
    expect(config.director.auto_trigger_delay_ms).toBe(500);
  });

  it('empty YAML file returns all defaults', async () => {
    const pipelineDir = join(TEST_DIR, '.pipeline');
    mkdirSync(pipelineDir, { recursive: true });

    await Bun.write(join(pipelineDir, 'config.yaml'), '');

    const config = await loadConfig(TEST_DIR);

    expect(config.branch.main).toBe('main');
    expect(config.tiers.small.max_files).toBe(3);
    expect(config.logging.level).toBe('info');
  });

  // ── Webhooks configuration ──────────────────────────────────

  it('parses webhook configuration from YAML', async () => {
    const pipelineDir = join(TEST_DIR, '.pipeline');
    mkdirSync(pipelineDir, { recursive: true });

    const yaml = `
adapters:
  webhooks:
    - url: https://hooks.example.com/pipeline
      events:
        - pipeline.completed
        - pipeline.failed
  retry_interval_ms: 30000
`;
    await Bun.write(join(pipelineDir, 'config.yaml'), yaml);

    const config = await loadConfig(TEST_DIR);

    expect(config.adapters.webhooks.length).toBe(1);
    expect(config.adapters.webhooks[0].url).toBe('https://hooks.example.com/pipeline');
    expect(config.adapters.webhooks[0].events).toEqual(['pipeline.completed', 'pipeline.failed']);
    expect(config.adapters.retry_interval_ms).toBe(30_000);
  });
});
