import { describe, expect, test } from 'vitest';

import { createSandboxManagerProcessAdapter } from '../adapters/local-runtime.js';
import { createAgent, createSession, sandbox } from '../index.js';
import { createFakeRuntime } from '../testing.js';

describe('sandbox intent', () => {
  test('constructs local, process, and runner sandbox intents', () => {
    expect(sandbox.local()).toEqual({ kind: 'local' });
    expect(sandbox.process({ isolation: 'podman' })).toMatchObject({
      kind: 'process',
      isolation: 'podman',
    });
    expect(sandbox.runner({ provider: 'modal', threadId: 't1' })).toMatchObject({
      kind: 'runner',
      provider: 'modal',
      threadId: 't1',
    });
  });

  test('fails before execution when backend is unsupported', async () => {
    const runtime = createFakeRuntime({
      capabilities: { runnerSandbox: false, toolExposure: true },
    });
    const session = createSession({
      agent: createAgent({ instructions: 'Help.', sandbox: sandbox.runner() }),
      runtime,
      cwd: '/repo',
    });

    await expect(session.prompt('hello')).rejects.toMatchObject({
      code: 'unsupported_sandbox_backend',
    });
    expect(runtime.requests).toHaveLength(0);
  });

  test('delegates runner sandbox resolution to runtime', async () => {
    const runtime = createFakeRuntime({
      capabilities: { runnerSandbox: true, toolExposure: true },
      resolveSandbox: (request) => ({
        kind: 'runner',
        id: 'runner-1',
        cwd: request.cwd,
      }),
    });
    const session = createSession({
      agent: createAgent({
        instructions: 'Help.',
        sandbox: sandbox.runner({ provider: 'default' }),
      }),
      runtime,
      cwd: '/repo',
    });

    await session.prompt('hello');

    expect(runtime.sandboxRequests).toHaveLength(1);
    expect(runtime.sandboxRequests[0].intent.kind).toBe('runner');
  });

  test('process sandbox adapter maps SandboxManager to spawn hook and cleanup', async () => {
    const calls: string[] = [];
    const adapter = createSandboxManagerProcessAdapter({
      async startSandbox({ requestId }) {
        calls.push(`start:${requestId}`);
      },
      createSpawnFn(requestId) {
        calls.push(`spawn:${requestId}`);
        return () => ({}) as any;
      },
      async stopSandbox(requestId) {
        calls.push(`stop:${requestId}`);
      },
    });

    const handle = await adapter.resolve({
      intent: sandbox.process({ isolation: 'podman', requestId: 's1' }),
      cwd: '/repo',
    });
    await handle.cleanup?.();

    expect(handle.kind).toBe('process');
    expect(handle.cwd).toBe('/workspace');
    expect(handle.spawnClaudeCodeProcess).toBeTypeOf('function');
    expect(calls).toEqual(['start:s1', 'spawn:s1', 'stop:s1']);
  });
});
