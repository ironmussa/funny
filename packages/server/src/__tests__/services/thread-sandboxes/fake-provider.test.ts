import { describe, expect, test } from 'bun:test';

import {
  createFakeSandboxProvider,
  type FakeProviderOptions,
  type FakeSandboxProvider,
} from '../../../services/thread-sandboxes/providers/fake/fake-provider.js';
import { runSandboxProviderContract } from './provider-contract.js';

function harness(opts: FakeProviderOptions) {
  return {
    provider: () => createFakeSandboxProvider('fake-valid', opts),
    providerWithBadCredential: () => createFakeSandboxProvider('nope', opts),
    knownVersion: '0.0.0-test',
    expire: (p: unknown, handle: { sandboxId: string }) =>
      (p as FakeSandboxProvider).expire(handle.sandboxId),
  };
}

runSandboxProviderContract('fake (disk-preserving)', harness({ stopPreservesDisk: true }));
runSandboxProviderContract(
  'fake (ephemeral, no lifetime cap)',
  harness({ stopPreservesDisk: false, maxLifetimeMs: null }),
);

describe('fake provider test controls', () => {
  test('failNext injects one normalized error', async () => {
    const provider = createFakeSandboxProvider('fake-valid');
    provider.failNext({ kind: 'rate-limited', message: 'slow down', retryAfterMs: 5_000 });
    const first = await provider.validate();
    expect(first.isErr() && first.error.kind).toBe('rate-limited');
    expect((await provider.validate()).isOk()).toBe(true);
  });
});
