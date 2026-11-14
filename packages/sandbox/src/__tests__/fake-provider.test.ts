import { describe, expect, test } from 'bun:test';

import {
  createFakeSandboxProvider,
  type FakeProviderOptions,
  type FakeSandboxProvider,
} from '../providers/fake/fake-provider.js';
import { runSandboxProviderContract } from '../testing/provider-contract.js';

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

describe('fake sandbox provider exec', () => {
  test('runs the commands with the exec option, only while the sandbox runs', async () => {
    const ran: string[] = [];
    const provider = createFakeSandboxProvider('fake-valid', {
      exec: (sandboxId, command) => {
        ran.push(`${sandboxId}: ${command}`);
        return { exitCode: 3, stdout: 'out', stderr: '' };
      },
    });
    const handle = (
      await provider.create({ ownerKey: 'o', sizeId: 'default', env: {}, idempotencyKey: 'k' })
    )._unsafeUnwrap();
    const result = (await provider.exec(handle, 'echo hi'))._unsafeUnwrap();
    expect(result).toEqual({ exitCode: 3, stdout: 'out', stderr: '' });
    expect(ran).toEqual([`${handle.sandboxId}: echo hi`]);

    (await provider.stop(handle))._unsafeUnwrap();
    expect((await provider.exec(handle, 'echo again')).isErr()).toBe(true);
    expect(ran).toHaveLength(1);
  });
});
