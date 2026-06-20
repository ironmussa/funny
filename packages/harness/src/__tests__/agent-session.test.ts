import { describe, expect, test } from 'vitest';
import { z } from 'zod';

import { createAgent, createSession, defineTool, HarnessError, sandbox } from '../index.js';
import { createFakeRuntime } from '../testing.js';

describe('agent definitions and sessions', () => {
  test('createAgent returns normalized immutable definitions', () => {
    const agent = createAgent({
      provider: 'codex',
      model: 'gpt-5',
      instructions: 'Review code.',
      permissionMode: 'plan',
      allowedTools: ['Read'],
      disallowedTools: ['Bash'],
      sandbox: sandbox.process({ isolation: 'podman' }),
    });

    expect(agent.provider).toBe('codex');
    expect(agent.name).toBe('codex');
    expect(agent.allowedTools).toEqual(['Read']);
    expect(agent.sandbox.kind).toBe('process');
    expect(Object.isFrozen(agent)).toBe(true);
    expect(Object.isFrozen(agent.allowedTools)).toBe(true);
  });

  test('session.prompt delegates to runtime and passes continuation session id', async () => {
    const runtime = createFakeRuntime();
    const events: string[] = [];
    const agent = createAgent({ instructions: 'Help.' });
    const session = createSession({
      agent,
      runtime,
      cwd: '/repo',
      sessionId: 'existing-session',
      onEvent: (event) => {
        events.push(event.type);
      },
    });

    const result = await session.prompt('hello');

    expect(result.ok).toBe(true);
    expect(runtime.requests).toHaveLength(1);
    expect(runtime.requests[0].sessionId).toBe('existing-session');
    expect(runtime.requests[0].prompt).toBe('hello');
    expect(session.sessionId).toBe('existing-session');
    expect(events).toContain('session.started');
  });

  test('session stores returned provider session id', async () => {
    const runtime = createFakeRuntime({
      spawnAgent: () => ({ ok: true, output: 'ok', sessionId: 'new-session' }),
    });
    const session = createSession({
      agent: createAgent({ instructions: 'Help.' }),
      runtime,
      cwd: '/repo',
    });

    await session.prompt('hello');

    expect(session.sessionId).toBe('new-session');
  });

  test('unsupported custom tool exposure fails before agent start', async () => {
    const tool = defineTool({
      name: 'lookup',
      description: 'Lookup a value.',
      inputSchema: z.object({ id: z.string() }),
      handler: ({ id }) => id,
    });
    const runtime = createFakeRuntime({ capabilities: { toolExposure: false } });
    const session = createSession({
      agent: createAgent({ instructions: 'Help.', tools: [tool] }),
      runtime,
      cwd: '/repo',
    });

    await expect(session.prompt('hello')).rejects.toMatchObject({
      code: 'unsupported_tool_exposure',
    });
    expect(runtime.requests).toHaveLength(0);
  });

  test('runtime failure is normalized and emitted', async () => {
    const runtime = createFakeRuntime({
      spawnAgent: () => {
        throw new Error('boom');
      },
    });
    const eventTypes: string[] = [];
    const session = createSession({
      agent: createAgent({ instructions: 'Help.' }),
      runtime,
      cwd: '/repo',
      onEvent: (event) => {
        eventTypes.push(event.type);
      },
    });

    await expect(session.prompt('hello')).rejects.toBeInstanceOf(HarnessError);
    expect(eventTypes).toContain('session.error');
  });
});
