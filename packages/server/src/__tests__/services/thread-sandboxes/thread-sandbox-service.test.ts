import { describe, expect, test } from 'bun:test';

import { REVERSE_LINK_LOOPBACK_PORT } from '@funny/shared/reverse-link';
import { nextSandboxState, type SandboxState } from '@funny/shared/sandbox-machine';
import { okAsync, errAsync, ResultAsync } from 'neverthrow';

import { hashLlmProxyToken } from '../../../services/llm-proxy/llm-proxy-tokens.js';
import {
  createFakeSandboxProvider,
  type FakeSandboxProvider,
} from '../../../services/thread-sandboxes/providers/fake/fake-provider.js';
import { resolveRunnerBuild } from '../../../services/thread-sandboxes/runner-build.js';
import {
  reverseLinkSecret,
  type RunnerLink,
} from '../../../services/thread-sandboxes/runner-link.js';
import { createRunnerTemplateManager } from '../../../services/thread-sandboxes/template-manager.js';
import { createThreadSandboxService } from '../../../services/thread-sandboxes/thread-sandbox-service.js';
import type {
  ThreadSandboxRow,
  ThreadSandboxStore,
} from '../../../services/thread-sandboxes/thread-sandbox-store.js';
import { expectOk } from './provider-contract.js';

const build = expectOk(resolveRunnerBuild({ FUNNY_BUILD_COMMIT: 'c'.repeat(40) }));

function memoryStore(): ThreadSandboxStore & { rows: Map<string, ThreadSandboxRow> } {
  const rows = new Map<string, ThreadSandboxRow>();
  return {
    rows,
    get: (threadId) => okAsync(rows.get(threadId) ?? null),
    put: (row) => {
      rows.set(row.threadId, { ...row });
      return okAsync(undefined);
    },
    update: (threadId, patch) => {
      const row = rows.get(threadId);
      if (row) rows.set(threadId, { ...row, ...patch });
      return okAsync(undefined);
    },
    // Same rule as the SQL store: only states that accept the event move.
    transition: (threadId, event, patch = {}) => {
      const row = rows.get(threadId);
      const next = row ? nextSandboxState(row.state as SandboxState, event) : null;
      if (!row || !next) {
        return okAsync({ applied: false, current: (row?.state as SandboxState) ?? null });
      }
      rows.set(threadId, { ...row, ...patch, state: next });
      return okAsync({ applied: true, state: next });
    },
    remove: (threadId) => {
      rows.delete(threadId);
      return okAsync(undefined);
    },
  };
}

interface Setup {
  checkouts: Array<{ threadId: string; path: string; repoUrl: string }>;
  provider: FakeSandboxProvider;
  store: ReturnType<typeof memoryStore>;
  service: ReturnType<typeof createThreadSandboxService>;
  issued: string[];
  removedRunners: string[];
}

function setup(
  opts: {
    templates?: string[];
    runnerConnects?: boolean;
    checkoutFails?: boolean;
    runnerLink?: RunnerLink;
  } = {},
): Setup {
  const provider = createFakeSandboxProvider('fake-valid', { templates: opts.templates ?? [] });
  const store = memoryStore();
  const issued: string[] = [];
  const checkouts: Setup['checkouts'] = [];
  const removedRunners: string[] = [];
  // The runner "connects" once the start command ran in the sandbox.
  const started = () => provider.commands.some((c) => c.command.includes('systemctl restart'));
  const service = createThreadSandboxService({
    connections: {
      providerFor: (userId, id) =>
        userId === 'alice' && id === 'conn-1'
          ? okAsync({ connectionId: id, provider })
          : errAsync({ kind: 'not-found' as const, message: id }),
    },
    templates: createRunnerTemplateManager(build),
    build,
    runnerLink: opts.runnerLink ?? { kind: 'direct', serverUrl: 'https://funny.example' },
    issueToken: ({ threadId }) => {
      const token = `rprov_${threadId}`;
      issued.push(token);
      return okAsync({ token });
    },
    sandboxRunnerIdForThread: async () =>
      opts.runnerConnects === false ? null : started() ? 'r-box' : null,
    presence: { isAvailable: (id) => id === 'r-box' },
    requestCheckout: ({ threadId, path, repoUrl }) => {
      checkouts.push({ threadId, path, repoUrl });
      return opts.checkoutFails ? errAsync('clone failed') : okAsync(undefined);
    },
    store,
    sleep: async () => {},
    pollMs: 1,
    readyTimeoutMs: 1_000,
    connectTimeoutMs: 200,
    removeRunner: async (runnerId) => {
      removedRunners.push(runnerId);
    },
  });
  return { provider, store, service, issued, checkouts, removedRunners };
}

const input = { userId: 'alice', threadId: 't-1', connectionId: 'conn-1' };

describe('thread sandbox provisioning', () => {
  test('with a ready template: create from it, start the runner with a token, end running', async () => {
    const { provider, store, service, issued } = setup({ templates: [build.version] });
    const row = expectOk(await service.provision(input));

    expect(row).toMatchObject({ state: 'running', runnerId: 'r-box', sizeId: 'default' });
    const [sandbox] = [...provider.sandboxes.values()];
    expect(sandbox.request.template?.ref).toBe(`funny-runner-${build.version}`);
    expect(sandbox.request.idempotencyKey).toBe('t-1:0');
    // Within the strictest provider plan (Boat's trial refuses auto-stops over 2 h).
    expect(sandbox.request.lifetimeMs).toBe(2 * 60 * 60_000);
    const commands = provider.commands.map((c) => c.command);
    expect(commands.some((c) => c.includes('funny-install-runner.sh'))).toBe(false);
    expect(commands.at(-1)).toContain(`RUNNER_PROVISION_TOKEN=${issued[0]}`);
    expect(commands.at(-1)).toContain('TEAM_SERVER_URL=https://funny.example');
    // The sandbox gets an LLM proxy token; only its hash is stored.
    const llmToken = commands.at(-1)?.match(/FUNNY_LLM_PROXY_TOKEN=(llmp_[A-Za-z0-9_-]+)/)?.[1];
    expect(llmToken).toBeDefined();
    expect(store.rows.get('t-1')?.llmTokenHash).toBe(hashLlmProxyToken(llmToken!));
    expect(store.rows.get('t-1')?.sandboxId).toBe(
      sandbox ? [...provider.sandboxes.keys()][0] : null,
    );
  });

  test('a reverse link points the runner at the relay and gives it its secret', async () => {
    const secretKey = Buffer.from('k'.repeat(32));
    const { provider, store, service } = setup({
      templates: [build.version],
      runnerLink: { kind: 'reverse', secretKey },
    });
    expectOk(await service.provision(input));
    const start = provider.commands.map((c) => c.command).at(-1);
    expect(start).toContain(`TEAM_SERVER_URL=http://127.0.0.1:${REVERSE_LINK_LOOPBACK_PORT}`);
    expect(start).toContain(`FUNNY_REVERSE_LINK_SECRET=${reverseLinkSecret(secretKey, 't-1', 0)}`);
    expect(store.rows.get('t-1')?.runnerLink).toBe('reverse');
  });

  test('without a template: install on the fly and build the template for the next thread', async () => {
    const { provider, service } = setup();
    const row = expectOk(await service.provision(input));
    expect(row.state).toBe('running');
    const [sandbox] = [...provider.sandboxes.values()];
    expect(sandbox.request.template).toBeUndefined();
    expect(provider.commands[0].command).toContain('funny-install-runner.sh');
    // Background build kicked off for the next thread.
    await Bun.sleep(5);
    expect(provider.templateBuilds).toHaveLength(1);
  });

  test('a runner that never connects fails the thread and destroys the machine', async () => {
    const { provider, store, service } = setup({
      templates: [build.version],
      runnerConnects: false,
    });
    const result = await service.provision(input);
    expect(result.isErr() && result.error.kind).toBe('sandbox');
    expect(store.rows.get('t-1')?.state).toBe('failed');
    expect(store.rows.get('t-1')?.error).toContain('timed out');
    expect(provider.sandboxes.size).toBe(0);
  });

  test('an active sandbox cannot be provisioned twice; a failed one starts a new generation', async () => {
    const { store, service } = setup({ templates: [build.version] });
    expectOk(await service.provision(input));
    const again = await service.provision(input);
    expect(again.isErr() && again.error.kind).toBe('already-provisioned');

    store.rows.set('t-1', { ...store.rows.get('t-1')!, state: 'failed' });
    const retried = expectOk(await service.provision(input));
    expect(retried.generation).toBe(1);
  });

  test('a foreign connection and an unknown size are refused before anything is created', async () => {
    const { provider, service } = setup({ templates: [build.version] });
    const foreign = await service.provision({ ...input, userId: 'mallory' });
    expect(foreign.isErr() && foreign.error.kind).toBe('connection');
    const size = await service.provision({ ...input, sizeId: 'huge' });
    expect(size.isErr() && size.error.kind).toBe('invalid-size');
    expect(provider.sandboxes.size).toBe(0);
  });

  test('materializes the project at its path on the sandbox runner once it is connected', async () => {
    const { provider, service, checkouts } = setup({ templates: [build.version] });
    const checkout = { path: '/data/projects/acme', repoUrl: 'https://github.com/acme/app.git' };
    const row = expectOk(await service.provision({ ...input, checkout }));
    expect(row.state).toBe('running');
    expect(checkouts).toEqual([{ threadId: 't-1', ...checkout }]);
    const prepare = provider.commands.find((c) => c.command.includes('mkdir -p'));
    expect(prepare?.command).toContain("sudo mkdir -p '/data/projects'");
  });

  test('a failed checkout fails the thread and destroys the machine', async () => {
    const { provider, store, service } = setup({ templates: [build.version], checkoutFails: true });
    const result = await service.provision({
      ...input,
      checkout: { path: '/data/projects/acme', repoUrl: 'https://github.com/acme/app.git' },
    });
    expect(result.isErr() && result.error.kind).toBe('checkout');
    expect(store.rows.get('t-1')?.state).toBe('failed');
    expect(provider.sandboxes.size).toBe(0);
  });

  test('a project path needing shell quoting is refused', async () => {
    const { checkouts, service } = setup({ templates: [build.version] });
    const result = await service.provision({
      ...input,
      checkout: { path: "/data/it's here", repoUrl: 'https://github.com/acme/app.git' },
    });
    expect(result.isErr() && result.error.kind).toBe('checkout');
    expect(checkouts).toHaveLength(0);
  });

  test('stop then resume a disk-preserving sandbox; the runner comes back', async () => {
    const { provider, store, service } = setup({ templates: [build.version] });
    expectOk(await service.provision(input));
    expect(expectOk(await service.stop('t-1'))).toBe('stopped');
    const [sandbox] = [...provider.sandboxes.values()];
    expect(sandbox.state).toBe('stopped');
    expect(store.rows.get('t-1')?.state).toBe('stopped');

    expect(expectOk(await service.resume('t-1'))).toBe('r-box');
    expect(sandbox.state).toBe('running');
    expect(store.rows.get('t-1')?.state).toBe('running');
  });

  test('an expired disk on resume marks the thread lost', async () => {
    const { provider, store, service } = setup({ templates: [build.version] });
    expectOk(await service.provision(input));
    expectOk(await service.stop('t-1'));
    provider.expire([...provider.sandboxes.keys()][0]);
    const result = await service.resume('t-1');
    expect(result.isErr() && result.error.kind).toBe('sandbox');
    expect(store.rows.get('t-1')?.state).toBe('lost');
  });

  test('only a running sandbox can be stopped and only a stopped one resumed', async () => {
    const { service } = setup({ templates: [build.version] });
    expect((await service.stop('t-1')).isErr()).toBe(true);
    expectOk(await service.provision(input));
    expect((await service.resume('t-1')).isErr()).toBe(true);
  });
});

describe('stop and resume edge cases (state machine + Effect)', () => {
  /** A provisioned, running sandbox whose runner connection can be switched off. */
  async function runningSandbox() {
    const provider = createFakeSandboxProvider('fake-valid', { templates: [build.version] });
    const store = memoryStore();
    const runner = { online: true };
    const service = createThreadSandboxService({
      connections: { providerFor: (_u, id) => okAsync({ connectionId: id, provider }) },
      templates: createRunnerTemplateManager(build),
      build,
      runnerLink: { kind: 'direct', serverUrl: 'https://funny.example' },
      issueToken: () => okAsync({ token: 'rprov_x' }),
      sandboxRunnerIdForThread: async () => 'r-box',
      presence: { isAvailable: () => runner.online },
      store,
      sleep: async () => {},
      pollMs: 1,
    });
    expectOk(await service.provision(input));
    return { provider, store, service, runner };
  }

  test('a wake cut short by its timeout fails the sandbox instead of leaving it connecting', async () => {
    const { store, service, runner } = await runningSandbox();
    expect(expectOk(await service.stop('t-1'))).toBe('stopped');
    runner.online = false; // the runner never comes back
    const result = await service.resume('t-1', AbortSignal.timeout(50));
    expect(result.isErr()).toBe(true);
    expect(store.rows.get('t-1')?.state).toBe('failed');
  });

  test('a stop the provider refuses leaves the sandbox running', async () => {
    const { provider, store, service } = await runningSandbox();
    provider.failNext({ kind: 'provider', message: 'provider down' });
    expect((await service.stop('t-1')).isErr()).toBe(true);
    expect(store.rows.get('t-1')).toMatchObject({ state: 'running', error: 'provider down' });
  });
});

describe("destroying a deleted thread's sandbox", () => {
  test('destroys the machine, revokes the runner and drops the row', async () => {
    const { provider, store, service, removedRunners } = setup({ templates: [build.version] });
    expectOk(await service.provision(input));
    expectOk(await service.destroy('t-1'));
    expect(provider.sandboxes.size).toBe(0);
    expect(removedRunners).toEqual(['r-box']);
    expect(store.rows.has('t-1')).toBe(false);
  });

  test('works on a stopped sandbox and is a no-op without one', async () => {
    const { provider, store, service } = setup({ templates: [build.version] });
    expectOk(await service.destroy('t-1'));
    expectOk(await service.provision(input));
    expectOk(await service.stop('t-1'));
    expectOk(await service.destroy('t-1'));
    expect(provider.sandboxes.size).toBe(0);
    expect(store.rows.has('t-1')).toBe(false);
  });

  test('a machine the provider already lost still counts as destroyed', async () => {
    const { provider, store, service } = setup({ templates: [build.version] });
    expectOk(await service.provision(input));
    provider.failNext({ kind: 'not-found', message: 'gone' });
    expectOk(await service.destroy('t-1'));
    expect(store.rows.has('t-1')).toBe(false);
  });

  test('a provider failure keeps the row as failed so the leak stays visible', async () => {
    const { provider, store, service, removedRunners } = setup({ templates: [build.version] });
    expectOk(await service.provision(input));
    provider.failNext({ kind: 'provider', message: 'provider down' });
    expect((await service.destroy('t-1')).isErr()).toBe(true);
    expect(store.rows.get('t-1')?.state).toBe('failed');
    expect(removedRunners).toEqual([]);
  });
});

describe('step ordering and cancellation', () => {
  /**
   * A fake whose runner install takes `installMs` of real time and whose
   * runner connects as soon as the start command ran; `onInstall` runs when the
   * install begins.
   */
  function slowInstallSetup(opts: { installMs: number; onInstall?: () => void }) {
    const fake = createFakeSandboxProvider('fake-valid', { templates: [] });
    const provider: FakeSandboxProvider = {
      ...fake,
      exec: (handle, command) => {
        if (!command.includes('funny-install-runner')) return fake.exec(handle, command);
        opts.onInstall?.();
        return ResultAsync.fromSafePromise(
          new Promise((resolve) => setTimeout(resolve, opts.installMs)),
        ).andThen(() => fake.exec(handle, command));
      },
    };
    const store = memoryStore();
    const started = () => fake.commands.some((c) => c.command.includes('systemctl restart'));
    const service = createThreadSandboxService({
      connections: { providerFor: (_u, id) => okAsync({ connectionId: id, provider }) },
      templates: createRunnerTemplateManager(build),
      build,
      runnerLink: { kind: 'direct', serverUrl: 'https://funny.example' },
      issueToken: () => okAsync({ token: 'rprov_x' }),
      sandboxRunnerIdForThread: async () => (started() ? 'r-box' : null),
      presence: { isAvailable: (id) => id === 'r-box' },
      store,
      sleep: async () => {},
      pollMs: 1,
      connectTimeoutMs: 150,
    });
    return { fake, store, service };
  }

  test('the connect timeout counts from the runner start, not from machine creation', async () => {
    // Install (300 ms) is longer than the connect timeout (150 ms): the runner
    // connects right after it starts, so the sandbox must come up.
    const { service, store } = slowInstallSetup({ installMs: 300 });
    expect(expectOk(await service.provision(input)).state).toBe('running');
    expect(store.rows.get('t-1')?.state).toBe('running');
  });

  test('deleting the thread mid-setup stops it and destroys the machine it created', async () => {
    const controller = new AbortController();
    const { service, fake } = slowInstallSetup({
      installMs: 50,
      onInstall: () => controller.abort(),
    });
    const result = await service.provision({ ...input, signal: controller.signal });
    expect(result.isErr() && result.error.kind).toBe('cancelled');
    expect(fake.sandboxes.size).toBe(0);
    expect(fake.commands.some((c) => c.command.includes('systemctl restart'))).toBe(false);
  });
});

describe('ephemeral providers', () => {
  test('stopping destroys the machine and marks the sandbox lost', async () => {
    const provider = createFakeSandboxProvider('fake-valid', {
      templates: [build.version],
      stopPreservesDisk: false,
    });
    const store = memoryStore();
    const service = createThreadSandboxService({
      connections: { providerFor: (_u, id) => okAsync({ connectionId: id, provider }) },
      templates: createRunnerTemplateManager(build),
      build,
      runnerLink: { kind: 'direct', serverUrl: 'https://funny.example' },
      issueToken: () => okAsync({ token: 'rprov_x' }),
      sandboxRunnerIdForThread: async () => 'r-box',
      presence: { isAvailable: () => true },
      store,
      sleep: async () => {},
      pollMs: 1,
    });
    expectOk(await service.provision(input));
    expect(expectOk(await service.stop('t-1'))).toBe('lost');
    expect(provider.sandboxes.size).toBe(0);
  });
});

describe('resilience: transient retries, release, abandon, recover', () => {
  type Flaky = 'create' | 'stop' | 'destroy' | 'exec';

  /** A fake whose calls can be made to fail transiently, with the backoff recorded. */
  function resilientSetup() {
    const fake = createFakeSandboxProvider('fake-valid', { templates: [build.version] });
    const failing: Partial<Record<Flaky, number>> = {};
    const calls: Record<Flaky, number> = { create: 0, stop: 0, destroy: 0, exec: 0 };
    const flaky = <F extends (...args: never[]) => ResultAsync<unknown, unknown>>(
      name: Flaky,
      call: F,
    ): F =>
      ((...args: never[]) => {
        calls[name] += 1;
        if ((failing[name] ?? 0) > 0) {
          failing[name]! -= 1;
          return errAsync({ kind: 'unavailable', message: `${name} down`, retryAfterMs: 7 });
        }
        return call(...args);
      }) as F;
    const provider: FakeSandboxProvider = {
      ...fake,
      create: flaky('create', fake.create),
      stop: flaky('stop', fake.stop),
      destroy: flaky('destroy', fake.destroy),
      exec: flaky('exec', fake.exec),
    };
    const store = memoryStore();
    const waits: number[] = [];
    const runner = { online: true };
    const service = createThreadSandboxService({
      connections: { providerFor: (_u, id) => okAsync({ connectionId: id, provider }) },
      templates: createRunnerTemplateManager(build),
      build,
      runnerLink: { kind: 'direct', serverUrl: 'https://funny.example' },
      issueToken: () => okAsync({ token: 'rprov_x' }),
      sandboxRunnerIdForThread: async () => 'r-box',
      presence: { isAvailable: () => runner.online },
      store,
      sleep: async (ms) => {
        waits.push(ms);
      },
      pollMs: 1,
      connectTimeoutMs: 200,
    });
    return { fake, service, store, failing, calls, waits, runner };
  }

  test('a transient provider error is retried, honoring its retryAfterMs', async () => {
    const { service, store, failing, calls, waits } = resilientSetup();
    expectOk(await service.provision(input));
    failing.stop = 2;
    expect(expectOk(await service.stop('t-1'))).toBe('stopped');
    expect(calls.stop).toBe(3);
    expect(waits.filter((ms) => ms === 7)).toHaveLength(2);
    expect(store.rows.get('t-1')?.state).toBe('stopped');
  });

  test('retries are capped: a provider that stays down fails the operation', async () => {
    const { service, store, failing, calls } = resilientSetup();
    expectOk(await service.provision(input));
    failing.stop = 99;
    expect((await service.stop('t-1')).isErr()).toBe(true);
    expect(calls.stop).toBe(4); // first attempt + 3 retries
    expect(store.rows.get('t-1')?.state).toBe('running');
  });

  test('create is retried (its idempotency key yields one machine); exec never is', async () => {
    const first = resilientSetup();
    first.failing.create = 1;
    expectOk(await first.service.provision(input));
    expect(first.calls.create).toBe(2);
    expect(first.fake.sandboxes.size).toBe(1);

    const second = resilientSetup();
    second.failing.exec = 1;
    expect((await second.service.provision(input)).isErr()).toBe(true);
    expect(second.calls.exec).toBe(1);
    // The failed setup destroyed its machine and forgot it.
    expect(second.fake.sandboxes.size).toBe(0);
    expect(second.store.rows.get('t-1')).toMatchObject({ state: 'failed', sandboxId: null });
  });

  test('release frees the machine a failed setup could not destroy', async () => {
    const { fake, service, store, failing } = resilientSetup();
    failing.exec = 1;
    failing.destroy = 99; // the setup's own cleanup fails too
    expect((await service.provision(input)).isErr()).toBe(true);
    const sandboxId = store.rows.get('t-1')?.sandboxId;
    expect(sandboxId).toBeTruthy();
    expect(fake.sandboxes.has(sandboxId!)).toBe(true);

    failing.destroy = 0;
    expect(expectOk(await service.release('t-1'))).toBe(true);
    expect(fake.sandboxes.size).toBe(0);
    expect(store.rows.get('t-1')).toMatchObject({ state: 'failed', sandboxId: null });
    expect(expectOk(await service.release('t-1'))).toBe(false);
  });

  test('a live sandbox is never released', async () => {
    const { fake, service } = resilientSetup();
    expectOk(await service.provision(input));
    expect(expectOk(await service.release('t-1'))).toBe(false);
    expect(fake.sandboxes.size).toBe(1);
  });

  test('re-provisioning a failed thread releases the machine the old row still held', async () => {
    const { fake, service, store, failing } = resilientSetup();
    failing.exec = 1;
    failing.destroy = 99;
    expect((await service.provision(input)).isErr()).toBe(true);
    const oldId = store.rows.get('t-1')!.sandboxId!;
    failing.destroy = 0;
    expectOk(await service.provision(input));
    expect(fake.sandboxes.has(oldId)).toBe(false);
    expect(fake.sandboxes.size).toBe(1);
  });

  test('abandon fails an orphaned setup and destroys its machine', async () => {
    const { fake, service, store } = resilientSetup();
    expectOk(await service.provision(input));
    // As a crashed server would leave it: mid-install, machine up.
    store.rows.set('t-1', { ...store.rows.get('t-1')!, state: 'installing', runnerId: null });
    expect(expectOk(await service.abandon('t-1', 'server restarted'))).toBe(true);
    expect(fake.sandboxes.size).toBe(0);
    expect(store.rows.get('t-1')).toMatchObject({
      state: 'failed',
      error: 'server restarted',
      sandboxId: null,
    });
  });

  test('recover puts an orphaned wake back to sleep, keeping its disk', async () => {
    const { fake, service, store, runner } = resilientSetup();
    expectOk(await service.provision(input));
    store.rows.set('t-1', { ...store.rows.get('t-1')!, state: 'connecting' });
    runner.online = false;
    expect(expectOk(await service.recover('t-1'))).toBe('stopped');
    const [machine] = [...fake.sandboxes.values()];
    expect(machine.state).toBe('stopped');
  });

  test('recover completes a wake whose runner is back, and an interrupted stop', async () => {
    const { service, store } = resilientSetup();
    expectOk(await service.provision(input));
    store.rows.set('t-1', { ...store.rows.get('t-1')!, state: 'connecting' });
    expect(expectOk(await service.recover('t-1'))).toBe('running');

    store.rows.set('t-1', { ...store.rows.get('t-1')!, state: 'stopping' });
    expect(expectOk(await service.recover('t-1'))).toBe('stopped');
  });
});
