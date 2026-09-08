import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock claude-binary before importing provider-detection
vi.mock('../../utils/claude-binary.js', () => ({
  checkClaudeBinaryAvailability: () => ({ available: false, error: 'not found' }),
  validateClaudeBinary: () => {
    throw new Error('not found');
  },
}));

const mocks = vi.hoisted(() => ({ codex: vi.fn() }));

// SDK import and native CLI resolution are separate checks.
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({}));
vi.mock('@openai/codex-sdk', () => ({ Codex: mocks.codex }));

import {
  getAvailableProviders,
  resetProviderCache,
  resolveProviderAvailability,
  type ProviderSpawnRef,
} from '../../utils/provider-detection.js';

beforeEach(() => {
  resetProviderCache();
  mocks.codex.mockReset();
  mocks.codex.mockImplementation(function () {});
  vi.stubEnv('CODEX_BINARY_PATH', '');
  vi.stubEnv('CODEX_BIN', '');
});
afterEach(() => vi.unstubAllEnvs());

describe('provider-detection', () => {
  test('requires the native CLI even when the SDK imports successfully', async () => {
    mocks.codex.mockImplementation(function () {
      throw new Error('Unable to locate Codex CLI binaries');
    });
    expect((await getAvailableProviders()).get('codex')).toMatchObject({
      available: false,
      sdkAvailable: true,
      cliAvailable: false,
      error: expect.stringContaining('Codex CLI not found'),
    });
    expect(await resolveProviderAvailability([])).not.toContain('codex');
  });

  test('reports Codex available when its SDK resolves the CLI', async () => {
    expect((await getAvailableProviders()).get('codex')).toMatchObject({
      available: true,
      sdkAvailable: true,
      cliAvailable: true,
    });
  });

  test('rejects a missing explicit CLI override', async () => {
    vi.stubEnv('CODEX_BINARY_PATH', '/nonexistent/funny-test/codex');
    expect((await getAvailableProviders()).get('codex')?.available).toBe(false);
    expect(mocks.codex).not.toHaveBeenCalled();
  });

  test('passes an executable override to the SDK', async () => {
    vi.stubEnv('CODEX_BINARY_PATH', process.execPath);
    expect((await getAvailableProviders()).get('codex')?.available).toBe(true);
    expect(mocks.codex).toHaveBeenCalledWith({ codexPathOverride: process.execPath });
  });

  test('getAvailableProviders returns a Map', async () => {
    const providers = await getAvailableProviders();
    expect(providers).toBeInstanceOf(Map);
  });

  test('getAvailableProviders includes claude and codex', async () => {
    const providers = await getAvailableProviders();
    expect(providers.has('claude')).toBe(true);
    expect(providers.has('codex')).toBe(true);
  });

  test('each provider has expected shape', async () => {
    const providers = await getAvailableProviders();
    for (const [, info] of providers) {
      expect(typeof info.available).toBe('boolean');
      expect(typeof info.sdkAvailable).toBe('boolean');
      expect(typeof info.cliAvailable).toBe('boolean');
    }
  });

  test('results are cached after first call', async () => {
    const first = await getAvailableProviders();
    const second = await getAvailableProviders();
    expect(first).toBe(second); // Same reference
  });

  test('resetProviderCache clears cache', async () => {
    const first = await getAvailableProviders();
    resetProviderCache();
    const second = await getAvailableProviders();
    expect(first).not.toBe(second); // New Map instance
  });
});

describe('resolveProviderAvailability (model-picker-availability §1)', () => {
  const ref = (id: string, command: string, extra: Partial<ProviderSpawnRef['spawn']> = {}) =>
    ({ id, spawn: { command, args: [], binEnvVars: [], ...extra } }) satisfies ProviderSpawnRef;

  // The mocked SDK resolves Codex alongside the other available backends.
  const ALWAYS = ['claude', 'codex', 'pi', 'deepagent', 'llm-api'];

  test('only providers whose resolved command is on PATH are available', async () => {
    const refs = [ref('gemini', 'gemini')];
    const out = await resolveProviderAvailability(refs, {
      commandExists: () => false,
      env: {},
    });
    expect(out).toEqual(expect.arrayContaining(ALWAYS));
    expect(out).not.toContain('gemini');
  });

  test('installing another binary makes that provider available too', async () => {
    const refs = [ref('gemini', 'gemini')];
    const out = await resolveProviderAvailability(refs, {
      commandExists: (c) => c === 'gemini',
      env: {},
    });
    expect(out).toEqual(expect.arrayContaining(['codex', 'gemini']));
  });

  test('an env-var binary override is honored (resolveSpawnCommand precedence)', async () => {
    const refs = [ref('gemini', 'gemini', { binEnvVars: ['GEMINI_BIN'] })];
    const out = await resolveProviderAvailability(refs, {
      commandExists: (c) => c === '/custom/gemini',
      env: { GEMINI_BIN: '/custom/gemini' },
    });
    expect(out).toContain('gemini');
  });

  test('the npx fallback counts as available when opted in', async () => {
    const refs = [
      ref('cursor', 'cursor-agent', { npxSpec: { useEnvVar: 'USE_NPX', pkg: ['-y', 'x'] } }),
    ];
    const out = await resolveProviderAvailability(refs, {
      commandExists: (c) => c === 'npx', // cursor-agent NOT installed, npx is
      env: { USE_NPX: '1' },
    });
    expect(out).toContain('cursor');
  });

  test('an active provider whose command is missing is absent', async () => {
    const refs = [ref('opencode', 'opencode')];
    const out = await resolveProviderAvailability(refs, {
      commandExists: () => false,
      env: {},
    });
    expect(out).not.toContain('opencode');
    expect(out).toEqual(expect.arrayContaining(ALWAYS)); // always-on still present
  });
});
