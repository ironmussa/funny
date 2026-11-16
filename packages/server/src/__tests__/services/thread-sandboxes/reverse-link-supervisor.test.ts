/**
 * reverse-link/supervisor.ts and runner-link.ts — which sandboxes get a
 * reverse-link dialer, and how a sandbox's runner is told to reach the server.
 */
import { describe, expect, test } from 'bun:test';

import { createFakeSandboxProvider } from '@funny/sandbox/providers/fake';
import {
  REVERSE_LINK_INGRESS_PORT,
  REVERSE_LINK_LOOPBACK_PORT,
  REVERSE_LINK_SECRET_ENV,
} from '@funny/shared/reverse-link';
import { err, errAsync, ok, okAsync } from 'neverthrow';

import type { ReverseLinkDialer } from '../../../services/thread-sandboxes/reverse-link/dialer.js';
import {
  createReverseLinkSupervisor,
  type ReverseLinkedSandbox,
} from '../../../services/thread-sandboxes/reverse-link/supervisor.js';
import {
  chooseRunnerLink,
  reverseLinkSecret,
  runnerLinkEnv,
} from '../../../services/thread-sandboxes/runner-link.js';

const KEY = Buffer.from('k'.repeat(32));

function setup(opts: { ingress?: boolean } = {}) {
  const provider = createFakeSandboxProvider('fake-valid', {
    ...(opts.ingress === false ? {} : { ingressBaseUrl: 'https://ingress.test' }),
  });
  let linked: ReverseLinkedSandbox[] = [];
  const started: Array<{
    sandbox: ReverseLinkedSandbox;
    url: string;
    secret: string;
    closed: boolean;
    unhealthy: () => void;
  }> = [];
  const clock = { ms: 0 };
  const attempts: number[] = [];
  const supervisor = createReverseLinkSupervisor({
    now: () => clock.ms,
    retry: { baseMs: 1_000, maxMs: 4_000 },
    listLinked: () => okAsync(linked),
    providerFor: () => {
      attempts.push(clock.ms);
      return okAsync(provider);
    },
    secretFor: (s) => reverseLinkSecret(KEY, s.threadId, s.generation),
    startDialer: ({ sandbox, ingress, secret, onUnhealthy }) => {
      const entry = { sandbox, url: ingress.url, secret, closed: false, unhealthy: onUnhealthy };
      started.push(entry);
      const dialer: ReverseLinkDialer = {
        spareCount: () => 0,
        pipeCount: () => 0,
        close: () => {
          entry.closed = true;
        },
      };
      return dialer;
    },
  });
  /** A running machine of the fake provider, as a linked row. */
  const machine = async (threadId: string, generation = 0): Promise<ReverseLinkedSandbox> => {
    const handle = await provider.create({
      ownerKey: threadId,
      sizeId: 'default',
      env: {},
      idempotencyKey: `${threadId}:${generation}`,
    });
    if (handle.isErr()) throw new Error(handle.error.message);
    return {
      threadId,
      generation,
      userId: 'u1',
      connectionId: 'c1',
      sandboxId: handle.value.sandboxId,
    };
  };
  return {
    attempts,
    clock,
    provider,
    supervisor,
    started,
    machine,
    setLinked: (rows: ReverseLinkedSandbox[]) => (linked = rows),
  };
}

describe('reverse link supervisor', () => {
  test('publishes the ingress port and starts one dialer per linked sandbox', async () => {
    const t = setup();
    const a = await t.machine('t-a');
    t.setLinked([a]);

    expect(await t.supervisor.sync()).toEqual({ linked: 1, started: 1, stopped: 0 });
    expect(t.provider.exposedPorts).toEqual([
      { sandboxId: a.sandboxId, port: REVERSE_LINK_INGRESS_PORT },
    ]);
    expect(t.started[0].url).toBe(
      `https://ingress.test/${a.sandboxId}/${REVERSE_LINK_INGRESS_PORT}`,
    );
    expect(t.started[0].secret).toBe(reverseLinkSecret(KEY, 't-a', 0));

    // A second pass keeps the dialer: no new publish, no new dialer.
    expect(await t.supervisor.sync()).toEqual({ linked: 1, started: 0, stopped: 0 });
    expect(t.provider.exposedPorts).toHaveLength(1);
  });

  test('a sandbox that leaves the linked states has its dialer closed', async () => {
    const t = setup();
    t.setLinked([await t.machine('t-a')]);
    await t.supervisor.sync();
    t.setLinked([]);
    expect(await t.supervisor.sync()).toEqual({ linked: 0, started: 0, stopped: 1 });
    expect(t.started[0].closed).toBe(true);
  });

  test('a re-provisioned sandbox (new generation) gets a new dialer and secret', async () => {
    const t = setup();
    const first = await t.machine('t-a', 0);
    t.setLinked([first]);
    await t.supervisor.sync();
    const second = await t.machine('t-a', 1);
    t.setLinked([second]);
    await t.supervisor.sync();
    expect(t.started.map((s) => s.closed)).toEqual([true, false]);
    expect(t.started[1].secret).not.toBe(t.started[0].secret);
  });

  test('an unhealthy dialer is dropped and redialed with fresh credentials', async () => {
    const t = setup();
    t.setLinked([await t.machine('t-a')]);
    await t.supervisor.sync();
    t.started[0].unhealthy();
    expect(t.started[0].closed).toBe(true);
    expect(await t.supervisor.sync()).toMatchObject({ linked: 1, started: 1 });
    expect(t.provider.exposedPorts).toHaveLength(2);
  });

  test('a provider that cannot publish yet is retried once its back-off has passed', async () => {
    const t = setup();
    const a = await t.machine('t-a');
    t.setLinked([a]);
    t.provider.failNext({ kind: 'unavailable', message: 'booting' });
    expect(await t.supervisor.sync()).toEqual({ linked: 0, started: 0, stopped: 0 });
    // Not before the delay: no provider call, no log, on every pass.
    expect(await t.supervisor.sync()).toEqual({ linked: 0, started: 0, stopped: 0 });
    expect(t.provider.exposedPorts).toHaveLength(0);
    t.clock.ms = 1_000;
    expect(await t.supervisor.sync()).toEqual({ linked: 1, started: 1, stopped: 0 });
  });

  test('repeated failures double the back-off up to its cap', async () => {
    const t = setup({ ingress: false });
    t.setLinked([await t.machine('t-a')]);
    for (let ms = 0; ms <= 12_000; ms += 500) {
      t.clock.ms = ms;
      await t.supervisor.sync();
    }
    // 1 s, then 2 s, then capped at 4 s.
    expect(t.attempts).toEqual([0, 1_000, 3_000, 7_000, 11_000]);
  });

  test('a sandbox that leaves and comes back starts without a stale back-off', async () => {
    const t = setup();
    const a = await t.machine('t-a');
    t.setLinked([a]);
    t.provider.failNext({ kind: 'unavailable', message: 'booting' });
    await t.supervisor.sync();
    t.setLinked([]);
    await t.supervisor.sync();
    t.setLinked([a]);
    expect(await t.supervisor.sync()).toMatchObject({ linked: 1, started: 1 });
  });

  test('a provider without exposePort never gets a dialer', async () => {
    const t = setup({ ingress: false });
    t.setLinked([await t.machine('t-a')]);
    expect(await t.supervisor.sync()).toEqual({ linked: 0, started: 0, stopped: 0 });
    expect(t.started).toHaveLength(0);
  });

  test('a failed listing keeps the current dialers', async () => {
    const t = setup();
    t.setLinked([await t.machine('t-a')]);
    await t.supervisor.sync();
    const failing = createReverseLinkSupervisor({
      listLinked: () => errAsync('db down'),
      providerFor: () => okAsync(t.provider),
      secretFor: () => 's',
      startDialer: () => {
        throw new Error('unreachable');
      },
    });
    expect(await failing.sync()).toEqual({ linked: 0, started: 0, stopped: 0 });
    expect(t.started[0].closed).toBe(false);
  });
});

describe('runner link choice', () => {
  const withIngress = createFakeSandboxProvider('fake-valid', { ingressBaseUrl: 'https://x.test' });
  const withoutIngress = createFakeSandboxProvider('fake-valid');
  const noPublicUrl = err({
    kind: 'no-public-url' as const,
    message: 'localhost is not reachable.',
  });

  test('a public server URL is used directly, whatever the provider', () => {
    const link = chooseRunnerLink(ok('https://funny.example'), withoutIngress, () => KEY);
    expect(link._unsafeUnwrap()).toEqual({ kind: 'direct', serverUrl: 'https://funny.example' });
    expect(runnerLinkEnv(link._unsafeUnwrap(), { threadId: 't', generation: 0 })).toEqual({
      TEAM_SERVER_URL: 'https://funny.example',
    });
  });

  test('without one, a provider that can publish a port gets the reverse link', () => {
    const link = chooseRunnerLink(noPublicUrl, withIngress, () => KEY)._unsafeUnwrap();
    expect(link.kind).toBe('reverse');
    expect(runnerLinkEnv(link, { threadId: 't', generation: 2 })).toEqual({
      TEAM_SERVER_URL: `http://127.0.0.1:${REVERSE_LINK_LOOPBACK_PORT}`,
      [REVERSE_LINK_SECRET_ENV]: reverseLinkSecret(KEY, 't', 2),
    });
  });

  test('without either, the launch is refused with both reasons', () => {
    const refusal = chooseRunnerLink(noPublicUrl, withoutIngress, () => KEY)._unsafeUnwrapErr();
    expect(refusal.code).toBe('no-runner-link');
    expect(refusal.message).toContain('localhost is not reachable');
    expect(refusal.message).toContain('cannot publish a port');
  });

  test('secrets are per thread and generation, and safe for the runner env file', () => {
    const a = reverseLinkSecret(KEY, 't', 0);
    expect(a).toBe(reverseLinkSecret(KEY, 't', 0));
    expect(a).not.toBe(reverseLinkSecret(KEY, 't', 1));
    expect(a).not.toBe(reverseLinkSecret(KEY, 'u', 0));
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
