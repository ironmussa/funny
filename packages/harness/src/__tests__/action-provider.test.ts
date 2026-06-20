import { describe, expect, test, vi } from 'vitest';

import {
  createActionProviderRuntime,
  type ActionProviderLike,
} from '../adapters/action-provider.js';
import { createAgent, createSession, sandbox } from '../index.js';

describe('ActionProvider bridge', () => {
  test('maps spawnAgent and command actions', async () => {
    const provider: ActionProviderLike = {
      spawnAgent: vi.fn(async () => ({
        ok: true,
        output: 'agent-output',
        metadata: { sessionId: 'ap-session' },
      })),
      runCommand: vi.fn(async () => ({ ok: true, output: 'stdout' })),
    };
    const runtime = createActionProviderRuntime({ provider });
    const session = createSession({
      agent: createAgent({
        provider: 'claude',
        model: 'sonnet',
        instructions: 'Review.',
        permissionMode: 'plan',
        allowedTools: ['Read'],
      }),
      runtime,
      cwd: '/repo',
    });

    const result = await session.prompt('hello');
    const command = await runtime.runCommand?.({ command: 'echo ok', cwd: '/repo' });

    expect(result).toMatchObject({ ok: true, output: 'agent-output', sessionId: 'ap-session' });
    expect(provider.spawnAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'hello',
        cwd: '/repo',
        mode: 'plan',
        model: 'sonnet',
        provider: 'claude',
        context: 'Review.',
        allowedTools: ['Read'],
      }),
    );
    expect(command).toMatchObject({ ok: true, stdout: 'stdout' });
  });

  test('delegates runner sandbox intent without provider SDKs', async () => {
    const provider: ActionProviderLike = {
      spawnAgent: async () => ({ ok: true, output: 'ok' }),
    };
    const resolveSandbox = vi.fn(async () => ({
      kind: 'runner' as const,
      id: 'runner-1',
      cwd: '/repo',
    }));
    const runtime = createActionProviderRuntime({
      provider,
      supportsRunnerSandbox: true,
      resolveSandbox,
    });
    const session = createSession({
      agent: createAgent({
        instructions: 'Review.',
        sandbox: sandbox.runner({ provider: 'default' }),
      }),
      runtime,
      cwd: '/repo',
    });

    await session.prompt('hello');

    expect(resolveSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: expect.objectContaining({ kind: 'runner', provider: 'default' }),
      }),
    );
  });
});
