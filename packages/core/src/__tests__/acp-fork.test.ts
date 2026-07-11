/**
 * Tests for `forkAcpSession` — spawns an ACP-compliant CLI just long enough to
 * call `unstable_forkSession()` on the source session, then tears it down.
 *
 * The lifecycle goes: SDK import → resolve binary → spawn child → await
 * 'spawn' / 'error' → initialize ACP connection → check `sessions.fork`
 * capability → call `unstable_forkSession`. We mock `child_process.spawn` and
 * `@agentclientprotocol/sdk` so the test exercises every branch without
 * shelling out to a real gemini / cursor / opencode binary.
 */

import { EventEmitter } from 'events';
import { Readable, Writable } from 'stream';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { forkAcpSession } from '../agents/acp-fork.js';

interface FakeChild extends EventEmitter {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  killed: boolean;
  kill: (sig?: string) => boolean;
  pid?: number;
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
  child.pid = 9_999_999;
  // Defer 'spawn' so the awaiter has time to register its listener.
  process.nextTick(() => child.emit('spawn'));
  return child;
}

const { spawnMock, mockInitialize, mockForkSession } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  mockInitialize: vi.fn(),
  mockForkSession: vi.fn(),
}));

vi.mock('child_process', () => ({ spawn: spawnMock }));
vi.mock('@agentclientprotocol/sdk', () => {
  class ClientSideConnection {
    initialize(...args: unknown[]) {
      return mockInitialize(...args);
    }
    unstable_forkSession(...args: unknown[]) {
      return mockForkSession(...args);
    }
  }
  return {
    ClientSideConnection,
    ndJsonStream: () => ({}) as unknown,
  };
});

const PROVIDER_ENVS = [
  'GEMINI_BINARY_PATH',
  'ACP_GEMINI_BIN',
  'CURSOR_BINARY_PATH',
  'ACP_CURSOR_BIN',
  'CURSOR_ACP_USE_NPX',
  'OPENCODE_BIN',
  'ACP_OPENCODE_BIN',
  'OPENCODE_ACP_USE_NPX',
];

describe('forkAcpSession', () => {
  let snapshot: Record<string, string | undefined>;
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    snapshot = Object.fromEntries(PROVIDER_ENVS.map((k) => [k, process.env[k]]));
    for (const k of PROVIDER_ENVS) delete process.env[k];
    killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    });

    spawnMock.mockReset();
    mockInitialize.mockReset();
    mockForkSession.mockReset();

    spawnMock.mockImplementation(() => makeFakeChild());
    mockInitialize.mockResolvedValue({
      agentCapabilities: { sessions: { fork: true } },
    });
    mockForkSession.mockResolvedValue({ sessionId: 'forked-session-id' });
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(snapshot)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    killSpy.mockRestore();
  });

  test('happy path: returns { ok: true, newSessionId } when fork capability is advertised', async () => {
    const res = await forkAcpSession({
      provider: 'gemini',
      sessionId: 'src-1',
      cwd: '/tmp/work',
    });

    expect(res).toEqual({ ok: true, newSessionId: 'forked-session-id' });
    expect(mockForkSession).toHaveBeenCalledWith({
      sessionId: 'src-1',
      cwd: '/tmp/work',
      mcpServers: [],
    });
  });

  test('returns { ok: false, capability_not_advertised } when fork is missing', async () => {
    mockInitialize.mockResolvedValueOnce({ agentCapabilities: {} });

    const res = await forkAcpSession({
      provider: 'gemini',
      sessionId: 'src-2',
      cwd: '/tmp/work',
    });

    expect(res).toEqual({ ok: false, reason: 'capability_not_advertised' });
    expect(mockForkSession).not.toHaveBeenCalled();
  });

  test('returns { ok: false, agent_error } when unstable_forkSession throws', async () => {
    mockForkSession.mockRejectedValueOnce(new Error('upstream blew up'));

    const res = await forkAcpSession({
      provider: 'cursor',
      sessionId: 'src-3',
      cwd: '/tmp/work',
    });

    expect(res).toMatchObject({ ok: false, reason: 'agent_error' });
    if (res.ok === false) {
      expect(res.message).toBe('upstream blew up');
    }
  });

  test('returns { ok: false, spawn_failed } when child emits an error before spawn', async () => {
    spawnMock.mockImplementationOnce(() => {
      const child = new EventEmitter() as FakeChild;
      child.stdin = new Writable({
        write(_c, _e, cb) {
          cb();
        },
      });
      child.stdout = new Readable({ read() {} });
      child.stderr = new Readable({ read() {} });
      child.killed = false;
      child.kill = vi.fn(() => true);
      process.nextTick(() => child.emit('error', new Error('ENOENT: cursor-agent')));
      return child;
    });

    const res = await forkAcpSession({
      provider: 'cursor',
      sessionId: 'src-4',
      cwd: '/tmp/work',
    });

    expect(res).toMatchObject({ ok: false, reason: 'spawn_failed' });
    if (res.ok === false) {
      expect(res.message).toBe('ENOENT: cursor-agent');
    }
  });

  test('default gemini command is `gemini` with `--acp`', async () => {
    await forkAcpSession({ provider: 'gemini', sessionId: 's', cwd: '/tmp' });
    expect(spawnMock).toHaveBeenCalledWith('gemini', ['--acp'], expect.any(Object));
  });

  test('default cursor command is `cursor-agent acp`', async () => {
    await forkAcpSession({ provider: 'cursor', sessionId: 's', cwd: '/tmp' });
    expect(spawnMock).toHaveBeenCalledWith('cursor-agent', ['acp'], expect.any(Object));
  });

  test('default opencode command is `opencode acp`', async () => {
    await forkAcpSession({ provider: 'opencode', sessionId: 's', cwd: '/tmp' });
    expect(spawnMock).toHaveBeenCalledWith('opencode', ['acp'], expect.any(Object));
  });

  test('opencode forks via the `sessionCapabilities.fork` shape (not `sessions.fork`)', async () => {
    // opencode advertises fork under agentCapabilities.sessionCapabilities.fork,
    // unlike codex/gemini/pi/cursor which use agentCapabilities.sessions.fork.
    mockInitialize.mockResolvedValueOnce({
      agentCapabilities: { sessionCapabilities: { fork: {} } },
    });

    const res = await forkAcpSession({
      provider: 'opencode',
      sessionId: 'src-oc',
      cwd: '/tmp/work',
    });

    expect(res).toEqual({ ok: true, newSessionId: 'forked-session-id' });
    expect(mockForkSession).toHaveBeenCalledWith({
      sessionId: 'src-oc',
      cwd: '/tmp/work',
      mcpServers: [],
    });
  });

  test('OPENCODE_BIN overrides the opencode command', async () => {
    process.env.OPENCODE_BIN = '/opt/my-opencode';
    await forkAcpSession({ provider: 'opencode', sessionId: 's', cwd: '/tmp' });
    expect(spawnMock).toHaveBeenCalledWith('/opt/my-opencode', ['acp'], expect.any(Object));
  });

  test('OPENCODE_ACP_USE_NPX=1 switches opencode to npx invocation', async () => {
    process.env.OPENCODE_ACP_USE_NPX = '1';
    await forkAcpSession({ provider: 'opencode', sessionId: 's', cwd: '/tmp' });
    expect(spawnMock).toHaveBeenCalledWith('npx', ['-y', 'opencode-ai', 'acp'], expect.any(Object));
  });

  test('GEMINI_BINARY_PATH overrides the gemini binary (args stay `--acp`)', async () => {
    process.env.GEMINI_BINARY_PATH = '/opt/my-gemini';
    await forkAcpSession({ provider: 'gemini', sessionId: 's', cwd: '/tmp' });
    expect(spawnMock).toHaveBeenCalledWith('/opt/my-gemini', ['--acp'], expect.any(Object));
  });

  test('CURSOR_ACP_USE_NPX=1 switches cursor to npx invocation', async () => {
    process.env.CURSOR_ACP_USE_NPX = '1';
    await forkAcpSession({ provider: 'cursor', sessionId: 's', cwd: '/tmp' });
    expect(spawnMock).toHaveBeenCalledWith(
      'npx',
      ['-y', 'cursor-agent', 'acp'],
      expect.any(Object),
    );
  });

  test('cwd and env are forwarded to spawn options', async () => {
    await forkAcpSession({
      provider: 'gemini',
      sessionId: 's',
      cwd: '/somewhere/else',
      env: { FOO: 'bar' },
    });

    const call = spawnMock.mock.calls[0];
    expect(call?.[2]).toMatchObject({ cwd: '/somewhere/else' });
    expect(call?.[2]?.env).toMatchObject({ FOO: 'bar' });
    expect(call?.[2]).toMatchObject({ detached: process.platform !== 'win32' });
  });

  test('child is killed on the happy path so it does not linger', async () => {
    const child = makeFakeChild();
    spawnMock.mockImplementationOnce(() => child);

    await forkAcpSession({ provider: 'gemini', sessionId: 's', cwd: '/tmp' });

    expect(child.kill).toHaveBeenCalled();
    expect(child.killed).toBe(true);
  });

  test('child is killed when the capability is missing (no leak on the early-return path)', async () => {
    const child = makeFakeChild();
    spawnMock.mockImplementationOnce(() => child);
    mockInitialize.mockResolvedValueOnce({ agentCapabilities: {} });

    await forkAcpSession({ provider: 'gemini', sessionId: 's', cwd: '/tmp' });

    expect(child.kill).toHaveBeenCalled();
  });
});
