import { describe, test, expect, vi, beforeEach } from 'vitest';

// Mock claude-binary before importing provider-detection
vi.mock('../../utils/claude-binary.js', () => ({
  checkClaudeBinaryAvailability: () => ({ available: false, error: 'not found' }),
  validateClaudeBinary: () => {
    throw new Error('not found');
  },
}));

// Mock the SDK imports — return empty objects so dynamic import() succeeds
// but the SDK check in provider-detection will still treat them as available
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({}));

import {
  getAvailableProviders,
  resetProviderCache,
  resolveProviderAvailability,
  type ProviderSpawnRef,
} from '../../utils/provider-detection.js';

describe('provider-detection', () => {
  beforeEach(() => {
    resetProviderCache();
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

  // claude is available here (the SDK import is mocked to {} → sdkAvailable),
  // alongside the always-on non-ACP backends.
  const ALWAYS = ['claude', 'deepagent', 'llm-api'];

  test('only providers whose resolved command is on PATH are available', async () => {
    const refs = [ref('codex', 'codex-acp'), ref('gemini', 'gemini')];
    const out = await resolveProviderAvailability(refs, {
      commandExists: (c) => c === 'codex-acp',
      env: {},
    });
    expect(out).toEqual(expect.arrayContaining([...ALWAYS, 'codex']));
    expect(out).not.toContain('gemini');
  });

  test('installing another binary makes that provider available too', async () => {
    const refs = [ref('codex', 'codex-acp'), ref('gemini', 'gemini')];
    const out = await resolveProviderAvailability(refs, {
      commandExists: (c) => c === 'codex-acp' || c === 'gemini',
      env: {},
    });
    expect(out).toEqual(expect.arrayContaining(['codex', 'gemini']));
  });

  test('an env-var binary override is honored (resolveSpawnCommand precedence)', async () => {
    const refs = [ref('codex', 'codex-acp', { binEnvVars: ['CODEX_BIN'] })];
    const out = await resolveProviderAvailability(refs, {
      commandExists: (c) => c === '/custom/codex',
      env: { CODEX_BIN: '/custom/codex' },
    });
    expect(out).toContain('codex');
  });

  test('the npx fallback counts as available when opted in', async () => {
    const refs = [
      ref('codex', 'codex-acp', { npxSpec: { useEnvVar: 'USE_NPX', pkg: ['-y', 'x'] } }),
    ];
    const out = await resolveProviderAvailability(refs, {
      commandExists: (c) => c === 'npx', // codex-acp NOT installed, npx is
      env: { USE_NPX: '1' },
    });
    expect(out).toContain('codex');
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
