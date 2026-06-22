/**
 * Regression: model selection must survive a session RESUME.
 *
 * On a follow-up message funny re-spawns the ACP agent and resumes via
 * `loadSession` instead of `newSession`. The resume branch used to discard
 * loadSession's response, so the agent's `category: 'model'` config option was
 * never captured. `applyModelSelection` then had no option to set and fell
 * through to "no model-selection method on ACP connection — using provider
 * default", silently dropping the user's model choice on every follow-up.
 *
 * `loadSession` returns the same `configOptions` as `newSession` (ACP 0.26+),
 * so the resume branch must capture them too. Observed live in thread
 * qtgxp-EvCrvHcxbrtIJIm: requested gpt-5.5, resumed → provider default.
 *
 * We mock `child_process.spawn` and `@agentclientprotocol/sdk` so the real
 * `runProcess()` lifecycle runs without shelling out to a codex binary.
 */

import { EventEmitter } from 'events';
import { Readable, Writable } from 'stream';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { CodexACPProcess } from '../agents/codex-acp.js';

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
  // No `pid` → killProcessTree() is a no-op (never signals a real process).
  process.nextTick(() => child.emit('spawn'));
  return child;
}

// The `category: 'model'` select option codex advertises in its session
// response (ACP 0.26+). Both newSession and loadSession return it.
const MODEL_OPTION = {
  id: 'model',
  category: 'model',
  type: 'select',
  name: 'Model',
  options: [
    { value: 'gpt-5.5', name: 'GPT-5.5' },
    { value: 'gpt-5.4', name: 'GPT-5.4' },
  ],
};

const {
  spawnMock,
  mockInitialize,
  mockNewSession,
  mockLoadSession,
  mockSetConfigOption,
  mockPrompt,
} = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  mockInitialize: vi.fn(),
  mockNewSession: vi.fn(),
  mockLoadSession: vi.fn(),
  mockSetConfigOption: vi.fn(),
  mockPrompt: vi.fn(),
}));

vi.mock('child_process', () => ({ spawn: spawnMock }));
vi.mock('@agentclientprotocol/sdk', () => {
  class ClientSideConnection {
    initialize(...a: unknown[]) {
      return mockInitialize(...a);
    }
    newSession(...a: unknown[]) {
      return mockNewSession(...a);
    }
    loadSession(...a: unknown[]) {
      return mockLoadSession(...a);
    }
    setSessionConfigOption(...a: unknown[]) {
      return mockSetConfigOption(...a);
    }
    setSessionMode() {
      return Promise.resolve();
    }
    prompt(...a: unknown[]) {
      return mockPrompt(...a);
    }
    cancel() {
      return Promise.resolve();
    }
  }
  return { ClientSideConnection, ndJsonStream: () => ({}) as unknown };
});

/**
 * Run the real `runProcess()` lifecycle until the first prompt is issued
 * (model selection happens just before it), then kill to unwind the
 * keep-alive `awaitShutdown()` loop.
 */
async function runUntilFirstPrompt(proc: CodexACPProcess): Promise<void> {
  const run = (proc as unknown as { runProcess: () => Promise<void> }).runProcess();
  for (let i = 0; i < 500 && mockPrompt.mock.calls.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
  await proc.kill();
  await run;
}

describe('CodexACPProcess resume — model selection', () => {
  beforeEach(() => {
    spawnMock.mockReset();
    mockInitialize.mockReset();
    mockNewSession.mockReset();
    mockLoadSession.mockReset();
    mockSetConfigOption.mockReset();
    mockPrompt.mockReset();

    spawnMock.mockImplementation(() => makeFakeChild());
    // Agent advertises loadSession so a stored sessionId triggers a resume.
    mockInitialize.mockResolvedValue({ agentCapabilities: { loadSession: true } });
    mockNewSession.mockResolvedValue({ sessionId: 'fresh-1', configOptions: [MODEL_OPTION] });
    mockLoadSession.mockResolvedValue({ configOptions: [MODEL_OPTION] });
    mockSetConfigOption.mockResolvedValue(undefined);
    mockPrompt.mockResolvedValue({ stopReason: 'end_turn' });
  });

  afterEach(() => {
    vi.clearAllTimers();
  });

  test('re-applies the requested model on resume (loadSession captures configOptions)', async () => {
    const proc = new CodexACPProcess({
      prompt: 'follow-up',
      cwd: '/tmp/test',
      model: 'gpt-5.5',
      sessionId: 'resume-1', // presence of a sessionId + loadSession cap → resume
    });

    await runUntilFirstPrompt(proc);

    // Resume path, not a fresh session.
    expect(mockLoadSession).toHaveBeenCalledTimes(1);
    expect(mockNewSession).not.toHaveBeenCalled();

    // The model is applied via setSessionConfigOption — NOT silently defaulted.
    expect(mockSetConfigOption).toHaveBeenCalledWith({
      sessionId: 'resume-1',
      configId: 'model',
      value: 'gpt-5.5',
    });
  });

  test('fresh session (no sessionId) still applies the model', async () => {
    const proc = new CodexACPProcess({
      prompt: 'first',
      cwd: '/tmp/test',
      model: 'gpt-5.5',
    });

    await runUntilFirstPrompt(proc);

    expect(mockNewSession).toHaveBeenCalledTimes(1);
    expect(mockLoadSession).not.toHaveBeenCalled();
    expect(mockSetConfigOption).toHaveBeenCalledWith({
      sessionId: 'fresh-1',
      configId: 'model',
      value: 'gpt-5.5',
    });
  });
});
