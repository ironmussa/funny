/**
 * Tests for `discoverOpenCodeModels` — spawns `opencode acp` just long enough to
 * call `initialize` + `newSession`, reads the advertised `models.availableModels`,
 * then tears the child down. We mock `child_process.spawn` and
 * `@agentclientprotocol/sdk` so every branch is exercised without shelling out.
 */

import { EventEmitter } from 'events';
import { Readable, Writable } from 'stream';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { discoverOpenCodeModels } from '../agents/opencode-discover.js';

interface FakeChild extends EventEmitter {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  killed: boolean;
  kill: (sig?: string) => boolean;
}

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdin = new Writable({
    write(_c, _e, cb) {
      cb();
    },
  });
  child.stdout = new Readable({ read() {} });
  child.stderr = new Readable({ read() {} });
  child.killed = false;
  child.kill = vi.fn(() => {
    child.killed = true;
    return true;
  });
  process.nextTick(() => child.emit('spawn'));
  return child;
}

const { spawnMock, mockInitialize, mockNewSession } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  mockInitialize: vi.fn(),
  mockNewSession: vi.fn(),
}));

vi.mock('child_process', () => ({ spawn: spawnMock }));
vi.mock('@agentclientprotocol/sdk', () => {
  class ClientSideConnection {
    initialize(...args: unknown[]) {
      return mockInitialize(...args);
    }
    newSession(...args: unknown[]) {
      return mockNewSession(...args);
    }
  }
  return { ClientSideConnection, ndJsonStream: () => ({}) as unknown };
});

const ENVS = ['OPENCODE_BIN', 'ACP_OPENCODE_BIN', 'OPENCODE_ACP_USE_NPX'];

describe('discoverOpenCodeModels', () => {
  let snapshot: Record<string, string | undefined>;

  beforeEach(() => {
    snapshot = Object.fromEntries(ENVS.map((k) => [k, process.env[k]]));
    for (const k of ENVS) delete process.env[k];

    spawnMock.mockReset();
    mockInitialize.mockReset();
    mockNewSession.mockReset();

    spawnMock.mockImplementation(() => makeFakeChild());
    mockInitialize.mockResolvedValue({ agentCapabilities: { loadSession: true } });
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(snapshot)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test('ok: returns advertised models and currentModelId', async () => {
    mockNewSession.mockResolvedValue({
      sessionId: 'ses_1',
      models: {
        currentModelId: 'opencode/big-pickle',
        availableModels: [
          { modelId: 'opencode/big-pickle', name: 'OpenCode Zen/Big Pickle' },
          { modelId: 'opencode/gpt-5-nano/high', name: 'OpenCode Zen/GPT-5 Nano (high)' },
        ],
      },
    });

    const res = await discoverOpenCodeModels();

    expect(res).toEqual({
      ok: true,
      currentModelId: 'opencode/big-pickle',
      models: [
        { modelId: 'opencode/big-pickle', name: 'OpenCode Zen/Big Pickle' },
        { modelId: 'opencode/gpt-5-nano/high', name: 'OpenCode Zen/GPT-5 Nano (high)' },
      ],
    });
    // default command
    expect(spawnMock).toHaveBeenCalledWith('opencode', ['acp'], expect.any(Object));
  });

  test('no_models: empty availableModels maps to reason no_models', async () => {
    mockNewSession.mockResolvedValue({ sessionId: 'ses_2', models: { availableModels: [] } });

    const res = await discoverOpenCodeModels();
    expect(res).toMatchObject({ ok: false, reason: 'no_models' });
  });

  test('auth_required: a login/auth error is classified', async () => {
    mockNewSession.mockRejectedValue(new Error('Authentication required: run opencode auth login'));

    const res = await discoverOpenCodeModels();
    expect(res).toMatchObject({ ok: false, reason: 'auth_required' });
  });

  test('agent_error: a generic failure is classified', async () => {
    mockNewSession.mockRejectedValue(new Error('upstream exploded'));

    const res = await discoverOpenCodeModels();
    expect(res).toMatchObject({ ok: false, reason: 'agent_error', message: 'upstream exploded' });
  });

  test('timeout: slow agent resolves to reason timeout', async () => {
    mockNewSession.mockImplementation(() => new Promise(() => {})); // never resolves

    const res = await discoverOpenCodeModels({ timeoutMs: 50 });
    expect(res).toMatchObject({ ok: false, reason: 'timeout' });
  });

  test('OPENCODE_BIN overrides the command', async () => {
    process.env.OPENCODE_BIN = '/opt/my-opencode';
    mockNewSession.mockResolvedValue({
      sessionId: 'ses_3',
      models: { availableModels: [{ modelId: 'm', name: 'M' }], currentModelId: 'm' },
    });

    await discoverOpenCodeModels();
    expect(spawnMock).toHaveBeenCalledWith('/opt/my-opencode', ['acp'], expect.any(Object));
  });
});
