import { EventEmitter } from 'node:events';

import { describe, expect, test } from 'vitest';

import { createLocalRuntime } from '../adapters/local-runtime.js';
import { createAgent, createSession, sandbox } from '../index.js';
import type { CoreAgentProcessLike, CoreProcessFactoryLike } from '../runtime.js';

class FakeProcess extends EventEmitter implements CoreAgentProcessLike {
  exited = false;
  constructor(private readonly behavior: 'success' | 'error' | 'exit' = 'success') {
    super();
  }
  start(): void {
    queueMicrotask(() => {
      if (this.behavior === 'error') {
        this.emit('error', new Error('provider failed'));
        return;
      }
      if (this.behavior === 'exit') {
        this.exited = true;
        this.emit('exit', 1);
        return;
      }
      this.emit('message', {
        type: 'assistant',
        message: {
          id: 'm1',
          content: [{ type: 'text', text: 'hello' }],
        },
      });
      this.emit('message', {
        type: 'result',
        subtype: 'success',
        is_error: false,
        duration_ms: 7,
        num_turns: 1,
        result: 'done',
        total_cost_usd: 0.01,
        session_id: 'provider-session',
      });
    });
  }
  async kill(): Promise<void> {
    this.exited = true;
  }
}

describe('local runtime adapter', () => {
  test('maps harness agent options to core process options and normalizes result', async () => {
    const captured: any[] = [];
    const factory: CoreProcessFactoryLike = {
      create(options) {
        captured.push(options);
        return new FakeProcess();
      },
    };
    const runtime = createLocalRuntime({ processFactory: factory });
    const session = createSession({
      agent: createAgent({
        provider: 'codex',
        model: 'gpt-5',
        instructions: 'System instructions.',
        permissionMode: 'plan',
        allowedTools: ['Read'],
      }),
      runtime,
      cwd: '/repo',
      sessionId: 'resume-me',
    });

    const result = await session.prompt('hello');

    expect(result).toMatchObject({
      ok: true,
      output: 'done',
      sessionId: 'provider-session',
      durationMs: 7,
      costUsd: 0.01,
    });
    expect(captured[0]).toMatchObject({
      prompt: 'hello',
      cwd: '/repo',
      provider: 'codex',
      model: 'gpt-5',
      sessionId: 'resume-me',
      systemPrefix: 'System instructions.',
      permissionMode: 'plan',
      allowedTools: ['Read'],
    });
  });

  test('normalizes process errors', async () => {
    const runtime = createLocalRuntime({
      processFactory: { create: () => new FakeProcess('error') },
    });
    const session = createSession({
      agent: createAgent({ instructions: 'Help.' }),
      runtime,
      cwd: '/repo',
    });

    await expect(session.prompt('hello')).rejects.toMatchObject({
      code: 'agent_execution_failed',
    });
  });

  test('passes process sandbox spawn hook to core process options', async () => {
    const captured: any[] = [];
    const runtime = createLocalRuntime({
      processFactory: {
        create(options) {
          captured.push(options);
          return new FakeProcess();
        },
      },
      processSandbox: {
        async resolve() {
          return {
            kind: 'process',
            cwd: '/workspace',
            spawnClaudeCodeProcess: () => ({}) as any,
          };
        },
      },
    });
    const session = createSession({
      agent: createAgent({
        instructions: 'Help.',
        sandbox: sandbox.process({ isolation: 'podman' }),
      }),
      runtime,
      cwd: '/repo',
    });

    await session.prompt('hello');

    expect(captured[0].cwd).toBe('/workspace');
    expect(captured[0].spawnClaudeCodeProcess).toBeTypeOf('function');
  });
});
