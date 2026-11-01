import { describe, expect, test } from 'bun:test';

import {
  fitsEnvLimits,
  isRetryableSandboxError,
  resolveSandboxSize,
} from '../../../services/thread-sandboxes/contract.js';
import { fakeSandboxProviderEntry } from '../../../services/thread-sandboxes/providers/fake/fake-provider.js';
import { createSandboxProviderRegistry } from '../../../services/thread-sandboxes/registry.js';
import { expectOk } from './provider-contract.js';

describe('sandbox provider registry', () => {
  test('lists registered providers without exposing factories', () => {
    const registry = expectOk(createSandboxProviderRegistry([fakeSandboxProviderEntry()]));
    const [entry] = registry.list();
    expect(entry.id).toBe('fake');
    expect(entry.capabilities.sizes.length).toBeGreaterThan(0);
    expect('create' in entry).toBe(false);
  });

  test('rejects duplicate provider ids', () => {
    const result = createSandboxProviderRegistry([
      fakeSandboxProviderEntry(),
      fakeSandboxProviderEntry(),
    ]);
    expect(result.isErr() && result.error.kind).toBe('duplicate-provider');
  });

  test('unknown provider is not instantiable', () => {
    const registry = expectOk(createSandboxProviderRegistry([fakeSandboxProviderEntry()]));
    const result = registry.instantiate({ providerId: 'boat', credential: 'x', config: {} });
    expect(result.isErr() && result.error.kind).toBe('unknown-provider');
  });

  test('config is validated by the provider schema', () => {
    const registry = expectOk(createSandboxProviderRegistry([fakeSandboxProviderEntry()]));
    const result = registry.instantiate({
      providerId: 'fake',
      credential: 'fake-valid',
      config: { unexpected: true },
    });
    expect(result.isErr() && result.error.kind).toBe('invalid-config');
  });

  test('instantiates a working provider', async () => {
    const registry = expectOk(createSandboxProviderRegistry([fakeSandboxProviderEntry()]));
    const provider = expectOk(
      registry.instantiate({ providerId: 'fake', credential: 'fake-valid', config: {} }),
    );
    expect((await provider.validate()).isOk()).toBe(true);
  });
});

describe('contract helpers', () => {
  const caps = fakeSandboxProviderEntry().capabilities;

  test('size falls back to the declared default and rejects unknown ids', () => {
    expect(resolveSandboxSize(caps)?.id).toBe('default');
    expect(resolveSandboxSize(caps, 'small')?.id).toBe('small');
    expect(resolveSandboxSize(caps, 'huge')).toBeUndefined();
  });

  test('env limits count vars and bytes', () => {
    expect(fitsEnvLimits(caps, { A: '1' })).toBe(true);
    expect(fitsEnvLimits(caps, { A: 'x'.repeat(64 * 1024) })).toBe(false);
    const many = Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`K${i}`, 'v']));
    expect(fitsEnvLimits(caps, many)).toBe(false);
  });

  test('only rate-limited and unavailable are retryable', () => {
    expect(isRetryableSandboxError({ kind: 'unavailable', message: '' })).toBe(true);
    expect(isRetryableSandboxError({ kind: 'rate-limited', message: '' })).toBe(true);
    expect(isRetryableSandboxError({ kind: 'quota', message: '' })).toBe(false);
    expect(isRetryableSandboxError({ kind: 'expired', message: '' })).toBe(false);
  });
});
