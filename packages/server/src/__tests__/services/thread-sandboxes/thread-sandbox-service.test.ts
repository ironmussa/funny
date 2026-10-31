import { describe, expect, test } from 'bun:test';

import { okAsync, errAsync } from 'neverthrow';

import {
  createFakeSandboxProvider,
  type FakeSandboxProvider,
} from '../../../services/thread-sandboxes/providers/fake/fake-provider.js';
import { resolveRunnerBuild } from '../../../services/thread-sandboxes/runner-build.js';
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
  };
}

interface Setup {
  provider: FakeSandboxProvider;
  store: ReturnType<typeof memoryStore>;
  service: ReturnType<typeof createThreadSandboxService>;
  issued: string[];
}

function setup(opts: { templates?: string[]; runnerConnects?: boolean } = {}): Setup {
  const provider = createFakeSandboxProvider('fake-valid', { templates: opts.templates ?? [] });
  const store = memoryStore();
  const issued: string[] = [];
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
    serverUrl: 'https://funny.example',
    issueToken: ({ threadId }) => {
      const token = `rprov_${threadId}`;
      issued.push(token);
      return okAsync({ token });
    },
    sandboxRunnerIdForThread: async () =>
      opts.runnerConnects === false ? null : started() ? 'r-box' : null,
    presence: { isAvailable: (id) => id === 'r-box' },
    store,
    sleep: async () => {},
    pollMs: 1,
    readyTimeoutMs: 1_000,
    connectTimeoutMs: 200,
  });
  return { provider, store, service, issued };
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
    const commands = provider.commands.map((c) => c.command);
    expect(commands.some((c) => c.includes('funny-install-runner.sh'))).toBe(false);
    expect(commands.at(-1)).toContain(`RUNNER_PROVISION_TOKEN=${issued[0]}`);
    expect(commands.at(-1)).toContain('TEAM_SERVER_URL=https://funny.example');
    expect(store.rows.get('t-1')?.sandboxId).toBe(
      sandbox ? [...provider.sandboxes.keys()][0] : null,
    );
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
});
