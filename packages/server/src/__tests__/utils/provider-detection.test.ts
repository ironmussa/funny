import { describe, test, expect, mock, beforeEach } from 'bun:test';

// Mock claude-binary before importing provider-detection
mock.module('../../utils/claude-binary.js', () => ({
  checkClaudeBinaryAvailability: () => ({ available: false, error: 'not found' }),
  validateClaudeBinary: () => {
    throw new Error('not found');
  },
}));

// Mock the SDK imports — return empty objects so dynamic import() succeeds
// but the SDK check in provider-detection will still treat them as available
mock.module('@anthropic-ai/claude-agent-sdk', () => ({}));
mock.module('@openai/codex-sdk', () => ({}));

import { getAvailableProviders, resetProviderCache } from '../../utils/provider-detection.js';

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
