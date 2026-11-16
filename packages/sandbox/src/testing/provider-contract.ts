/**
 * Shared contract suite every sandbox provider adapter MUST pass
 * (change `thread-sandboxes`, task 2.6). Adapters for real providers run it
 * against recorded fixtures; the fake provider runs it in-memory.
 */
import { describe, expect, test } from 'bun:test';

import type { Result } from 'neverthrow';

import { resolveSandboxSize, type SandboxHandle, type SandboxProvider } from '../contract.js';

/** Unwraps an ok Result in tests; fails the test with the error otherwise. */
export function expectOk<T, E>(result: Result<T, E>): T {
  if (result.isErr()) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
  return result.value;
}

export interface ProviderContractHarness {
  /** A provider with a valid credential, fresh per test. */
  provider: () => SandboxProvider;
  /** A provider whose credential the backend rejects. */
  providerWithBadCredential: () => SandboxProvider;
  /** A server version that has a published template. */
  knownVersion: string;
  /** Makes the provider drop the stopped disk of a sandbox (retention elapsed). */
  expire?: (provider: SandboxProvider, handle: SandboxHandle) => void;
}

export function runSandboxProviderContract(name: string, h: ProviderContractHarness) {
  describe(`sandbox provider contract: ${name}`, () => {
    const createOne = async (provider: SandboxProvider, key = 'thread-1:0') => {
      const caps = provider.capabilities();
      const template = expectOk(await provider.resolveTemplate(h.knownVersion));
      return expectOk(
        await provider.create({
          ownerKey: 'thread-1',
          sizeId: resolveSandboxSize(caps)!.id,
          template,
          env: { TEAM_SERVER_URL: 'https://funny.example' },
          lifetimeMs: caps.maxLifetimeMs ? 60_000 : undefined,
          idempotencyKey: key,
        }),
      );
    };

    test('declares coherent capabilities', () => {
      const caps = h.provider().capabilities();
      expect(caps.sizes.length).toBeGreaterThan(0);
      expect(caps.sizes.filter((s) => s.default).length).toBeLessThanOrEqual(1);
      expect(new Set(caps.sizes.map((s) => s.id)).size).toBe(caps.sizes.length);
      expect(caps.env.maxVars).toBeGreaterThanOrEqual(4);
      if (!caps.stopPreservesDisk) expect(caps.stoppedRetentionMs).toBeNull();
    });

    test('validate rejects a bad credential with kind auth', async () => {
      const result = await h.providerWithBadCredential().validate();
      expect(result.isErr() && result.error.kind).toBe('auth');
    });

    test('validate accepts a good credential', async () => {
      expect((await h.provider().validate()).isOk()).toBe(true);
    });

    test('missing template is template-missing', async () => {
      const result = await h.provider().resolveTemplate('0.0.0-does-not-exist');
      expect(result.isErr() && result.error.kind).toBe('template-missing');
    });

    test('create returns a running sandbox tagged with the provider id', async () => {
      const provider = h.provider();
      const handle = await createOne(provider);
      expect(handle.providerId).toBe(provider.id);
      const status = expectOk(await provider.status(handle));
      expect(['provisioning', 'running']).toContain(status.state);
    });

    test('create is idempotent per key', async () => {
      const provider = h.provider();
      const a = await createOne(provider, 'thread-1:7');
      const b = await createOne(provider, 'thread-1:7');
      expect(b.sandboxId).toBe(a.sandboxId);
    });

    test('stop/resume follow the declared capability', async () => {
      const provider = h.provider();
      const handle = await createOne(provider);
      const stopped = await provider.stop(handle);
      if (provider.capabilities().stopPreservesDisk) {
        expect(stopped.isOk()).toBe(true);
        expect(expectOk(await provider.status(handle)).state).toBe('stopped');
        expect((await provider.resume(handle)).isOk()).toBe(true);
        expect(expectOk(await provider.status(handle)).state).toBe('running');
      } else {
        expect(stopped.isErr() && stopped.error.kind).toBe('unsupported');
        const resumed = await provider.resume(handle);
        expect(resumed.isErr() && resumed.error.kind).toBe('unsupported');
      }
    });

    test('extendLifetime follows the declared capability', async () => {
      const provider = h.provider();
      const handle = await createOne(provider);
      const result = await provider.extendLifetime(handle, 120_000);
      if (provider.capabilities().maxLifetimeMs === null) {
        expect(result.isErr() && result.error.kind).toBe('unsupported');
      } else {
        expect(result.isOk()).toBe(true);
      }
    });

    test('resume of an expired disk is kind expired', async () => {
      const provider = h.provider();
      if (!provider.capabilities().stopPreservesDisk || !h.expire) return;
      const handle = await createOne(provider);
      expectOk(await provider.stop(handle));
      h.expire(provider, handle);
      const result = await provider.resume(handle);
      expect(result.isErr() && result.error.kind).toBe('expired');
    });

    test('destroy is idempotent and the sandbox becomes not-found', async () => {
      const provider = h.provider();
      const handle = await createOne(provider);
      expect((await provider.destroy(handle)).isOk()).toBe(true);
      expect((await provider.destroy(handle)).isOk()).toBe(true);
      const status = await provider.status(handle);
      expect(status.isErr() && status.error.kind).toBe('not-found');
    });
  });
}
