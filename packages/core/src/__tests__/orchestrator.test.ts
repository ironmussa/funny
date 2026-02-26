import { EventEmitter } from 'events';

import { describe, test, expect, beforeEach } from 'vitest';

import type {
  IAgentProcess,
  IAgentProcessFactory,
  AgentProcessOptions,
} from '../agents/interfaces.js';
import { AgentOrchestrator } from '../agents/orchestrator.js';
import type { CLIMessage } from '../agents/types.js';

// ── Mock process ────────────────────────────────────────────────

class MockProcess extends EventEmitter implements IAgentProcess {
  private _exited = false;
  public started = false;
  public options: AgentProcessOptions;

  constructor(opts: AgentProcessOptions) {
    super();
    this.options = opts;
  }

  start(): void {
    this.started = true;
    // Emit init so the resume handler's gotMessage flag gets set
    this.emit('message', {
      type: 'system',
      subtype: 'init',
      session_id: this.options.sessionId ?? 'mock-sess',
      tools: [],
      cwd: this.options.cwd ?? '/tmp',
    });
  }

  async kill(): Promise<void> {
    this._exited = true;
  }

  get exited(): boolean {
    return this._exited;
  }

  simulateMessage(msg: CLIMessage): void {
    this.emit('message', msg);
  }

  simulateExit(code: number | null = 0): void {
    this._exited = true;
    this.emit('exit', code);
  }

  simulateError(err: Error): void {
    this.emit('error', err);
  }
}

// ── Silent mock that does NOT emit init on start ────────────────

class SilentMockProcess extends MockProcess {
  start(): void {
    this.started = true;
    // Intentionally does NOT emit any message
  }
}

// ── Helpers ─────────────────────────────────────────────────────

function createFactory(
  ProcessClass: typeof MockProcess = MockProcess,
): IAgentProcessFactory & { lastProcess: MockProcess; processes: MockProcess[] } {
  const state = {
    lastProcess: null as any as MockProcess,
    processes: [] as MockProcess[],
    create(opts: AgentProcessOptions): IAgentProcess {
      const proc = new ProcessClass(opts);
      state.lastProcess = proc;
      state.processes.push(proc);
      return proc;
    },
  };
  return state;
}

function baseOpts(overrides?: Record<string, any>) {
  return {
    threadId: 't1',
    prompt: 'test prompt',
    cwd: '/tmp/repo',
    provider: 'claude' as const,
    model: 'sonnet' as const,
    permissionMode: 'autoEdit' as const,
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────

describe('AgentOrchestrator', () => {
  let orchestrator: AgentOrchestrator;
  let factory: ReturnType<typeof createFactory>;

  beforeEach(() => {
    factory = createFactory();
    orchestrator = new AgentOrchestrator(factory);
  });

  // ── startAgent ─────────────────────────────────────────────

  describe('startAgent', () => {
    test('creates and starts a process', async () => {
      await orchestrator.startAgent(baseOpts());

      expect(factory.lastProcess.started).toBe(true);
      expect(orchestrator.isRunning('t1')).toBe(true);
    });

    test('emits agent:started event', async () => {
      const events: string[] = [];
      orchestrator.on('agent:started', (id) => events.push(id));

      await orchestrator.startAgent(baseOpts());

      expect(events).toEqual(['t1']);
    });

    test('kills existing process before starting new one', async () => {
      await orchestrator.startAgent(baseOpts());
      const first = factory.lastProcess;

      await orchestrator.startAgent(baseOpts({ prompt: 'second' }));

      expect(first.exited).toBe(true);
      expect(factory.lastProcess).not.toBe(first);
    });

    test('passes resolved model ID to process', async () => {
      await orchestrator.startAgent(baseOpts({ model: 'opus' }));

      expect(factory.lastProcess.options.model).toBe('claude-opus-4-6');
    });

    test('passes permission mode to process', async () => {
      await orchestrator.startAgent(baseOpts({ permissionMode: 'autoEdit' }));

      expect(factory.lastProcess.options.permissionMode).toBe('bypassPermissions');
    });

    test('passes allowed tools to process', async () => {
      await orchestrator.startAgent(baseOpts());

      // Claude default tools should be passed
      expect(factory.lastProcess.options.allowedTools).toContain('Read');
      expect(factory.lastProcess.options.allowedTools).toContain('Edit');
    });

    test('uses custom allowedTools when provided', async () => {
      await orchestrator.startAgent(baseOpts({ allowedTools: ['Read'] }));

      expect(factory.lastProcess.options.allowedTools).toEqual(['Read']);
    });
  });

  // ── wireProcessHandlers (via startAgent) ────────────────────

  describe('process event handling', () => {
    test('forwards messages to agent:message event', async () => {
      const messages: CLIMessage[] = [];
      orchestrator.on('agent:message', (_id, msg) => messages.push(msg));

      await orchestrator.startAgent(baseOpts());

      // Init message was already emitted by MockProcess.start()
      expect(messages.length).toBeGreaterThanOrEqual(1);
      expect(messages[0].type).toBe('system');
    });

    test('tracks result received and prevents unexpected-exit', async () => {
      const unexpectedExits: string[] = [];
      orchestrator.on('agent:unexpected-exit', (id) => unexpectedExits.push(id));

      await orchestrator.startAgent(baseOpts());
      const proc = factory.lastProcess;

      // Send result then exit
      proc.simulateMessage({
        type: 'result',
        subtype: 'success',
        is_error: false,
        duration_ms: 5000,
        num_turns: 1,
        total_cost_usd: 0.01,
        session_id: 'sess-1',
      });
      proc.simulateExit(0);

      expect(unexpectedExits).toHaveLength(0);
    });

    test('emits unexpected-exit when no result received', async () => {
      const unexpectedExits: { id: string; code: number | null }[] = [];
      orchestrator.on('agent:unexpected-exit', (id, code) => unexpectedExits.push({ id, code }));

      await orchestrator.startAgent(baseOpts());
      factory.lastProcess.simulateExit(1);

      expect(unexpectedExits).toHaveLength(1);
      expect(unexpectedExits[0]).toEqual({ id: 't1', code: 1 });
    });

    test('forwards errors to agent:error event', async () => {
      const errors: { id: string; err: Error }[] = [];
      orchestrator.on('agent:error', (id, err) => errors.push({ id, err }));

      await orchestrator.startAgent(baseOpts());
      factory.lastProcess.simulateError(new Error('boom'));

      expect(errors).toHaveLength(1);
      expect(errors[0].err.message).toBe('boom');
    });

    test('suppresses error after result received', async () => {
      const errors: Error[] = [];
      orchestrator.on('agent:error', (_id, err) => errors.push(err));

      await orchestrator.startAgent(baseOpts());
      const proc = factory.lastProcess;

      proc.simulateMessage({
        type: 'result',
        subtype: 'success',
        is_error: false,
        duration_ms: 1000,
        num_turns: 1,
        total_cost_usd: 0,
        session_id: 's',
      });
      proc.simulateError(new Error('late error'));

      expect(errors).toHaveLength(0);
    });

    test('suppresses result for manually stopped agent', async () => {
      const messages: CLIMessage[] = [];
      orchestrator.on('agent:message', (_id, msg) => {
        if (msg.type === 'result') messages.push(msg);
      });

      await orchestrator.startAgent(baseOpts());
      const proc = factory.lastProcess;

      await orchestrator.stopAgent('t1');

      // Result emitted after manual stop should be suppressed
      proc.simulateMessage({
        type: 'result',
        subtype: 'success',
        is_error: false,
        duration_ms: 0,
        num_turns: 0,
        total_cost_usd: 0,
        session_id: 's',
      });

      expect(messages).toHaveLength(0);
    });

    test('manually stopped agent exit does not trigger unexpected-exit', async () => {
      const unexpectedExits: string[] = [];
      orchestrator.on('agent:unexpected-exit', (id) => unexpectedExits.push(id));

      await orchestrator.startAgent(baseOpts());
      const proc = factory.lastProcess;

      await orchestrator.stopAgent('t1');
      proc.simulateExit(null);

      expect(unexpectedExits).toHaveLength(0);
    });

    test('exit cleans up activeAgents', async () => {
      await orchestrator.startAgent(baseOpts());
      expect(orchestrator.isRunning('t1')).toBe(true);

      factory.lastProcess.simulateExit(0);
      expect(orchestrator.isRunning('t1')).toBe(false);
    });
  });

  // ── Resume with auto-retry ─────────────────────────────────

  describe('session resume', () => {
    test('prepends resume note to prompt', async () => {
      await orchestrator.startAgent(baseOpts({ sessionId: 'sess-old' }));

      expect(factory.lastProcess.options.prompt).toContain('[SYSTEM NOTE:');
      expect(factory.lastProcess.options.sessionId).toBe('sess-old');
    });

    test('retries fresh when resume crashes without messages', async () => {
      // Use SilentMockProcess so start() doesn't emit any messages
      factory = createFactory(SilentMockProcess);
      orchestrator = new AgentOrchestrator(factory);

      const clearedSessions: string[] = [];
      orchestrator.on('agent:session-cleared', (id) => clearedSessions.push(id));

      await orchestrator.startAgent(baseOpts({ sessionId: 'stale-sess' }));
      const resumeProc = factory.lastProcess;

      // Resume process dies without any messages
      resumeProc.simulateExit(1);

      // Should have created a fresh process (2 total)
      expect(factory.processes).toHaveLength(2);
      expect(clearedSessions).toEqual(['t1']);

      // Fresh process should not have sessionId
      const freshProc = factory.processes[1];
      expect(freshProc.options.sessionId).toBeUndefined();
      expect(freshProc.started).toBe(true);
    });

    test('does not retry when resume process produces messages', async () => {
      const clearedSessions: string[] = [];
      orchestrator.on('agent:session-cleared', (id) => clearedSessions.push(id));

      await orchestrator.startAgent(baseOpts({ sessionId: 'good-sess' }));
      const proc = factory.lastProcess;

      // Resume worked — got messages, then exit
      proc.simulateMessage({
        type: 'result',
        subtype: 'success',
        is_error: false,
        duration_ms: 1000,
        num_turns: 1,
        total_cost_usd: 0.01,
        session_id: 'good-sess',
      });
      proc.simulateExit(0);

      // Should NOT retry — only 1 process created
      expect(factory.processes).toHaveLength(1);
      expect(clearedSessions).toHaveLength(0);
    });

    test('resume error before any message is suppressed (retry on exit)', async () => {
      // Use SilentMockProcess so start() doesn't emit messages
      factory = createFactory(SilentMockProcess);
      orchestrator = new AgentOrchestrator(factory);

      const errors: Error[] = [];
      orchestrator.on('agent:error', (_id, err) => errors.push(err));

      await orchestrator.startAgent(baseOpts({ sessionId: 'bad-sess' }));
      const proc = factory.lastProcess;

      proc.simulateError(new Error('stale session'));

      // Error should be suppressed (not forwarded)
      expect(errors).toHaveLength(0);
    });

    test('resume error after messages is forwarded', async () => {
      const errors: Error[] = [];
      orchestrator.on('agent:error', (_id, err) => errors.push(err));

      await orchestrator.startAgent(baseOpts({ sessionId: 'live-sess' }));
      const proc = factory.lastProcess;

      // Process already got messages via start() init
      proc.simulateError(new Error('real error'));

      expect(errors).toHaveLength(1);
      expect(errors[0].message).toBe('real error');
    });
  });

  // ── stopAgent ──────────────────────────────────────────────

  describe('stopAgent', () => {
    test('kills the process and emits agent:stopped', async () => {
      const stoppedEvents: string[] = [];
      orchestrator.on('agent:stopped', (id) => stoppedEvents.push(id));

      await orchestrator.startAgent(baseOpts());
      await orchestrator.stopAgent('t1');

      expect(factory.lastProcess.exited).toBe(true);
      expect(orchestrator.isRunning('t1')).toBe(false);
      expect(stoppedEvents).toEqual(['t1']);
    });

    test('emits agent:stopped even when no active process', async () => {
      const stoppedEvents: string[] = [];
      orchestrator.on('agent:stopped', (id) => stoppedEvents.push(id));

      await orchestrator.stopAgent('nonexistent');

      expect(stoppedEvents).toEqual(['nonexistent']);
    });
  });

  // ── cleanupThread ──────────────────────────────────────────

  describe('cleanupThread', () => {
    test('removes all state for a thread', async () => {
      await orchestrator.startAgent(baseOpts());
      expect(orchestrator.isRunning('t1')).toBe(true);

      orchestrator.cleanupThread('t1');

      expect(orchestrator.isRunning('t1')).toBe(false);
    });

    test('is safe to call on unknown thread', () => {
      // Should not throw
      orchestrator.cleanupThread('nonexistent');
    });
  });

  // ── stopAll ────────────────────────────────────────────────

  describe('stopAll', () => {
    test('kills all active agents', async () => {
      await orchestrator.startAgent(baseOpts({ threadId: 't1' }));
      await orchestrator.startAgent(baseOpts({ threadId: 't2' }));

      expect(orchestrator.isRunning('t1')).toBe(true);
      expect(orchestrator.isRunning('t2')).toBe(true);

      await orchestrator.stopAll();

      expect(orchestrator.isRunning('t1')).toBe(false);
      expect(orchestrator.isRunning('t2')).toBe(false);
    });

    test('does nothing when no agents are running', async () => {
      // Should not throw
      await orchestrator.stopAll();
    });
  });

  // ── Multi-provider ─────────────────────────────────────────

  describe('multi-provider support', () => {
    test('resolves Gemini model ID correctly', async () => {
      await orchestrator.startAgent(
        baseOpts({
          provider: 'gemini',
          model: 'gemini-3-flash-preview',
        }),
      );

      expect(factory.lastProcess.options.model).toBe('gemini-3-flash-preview');
      expect(factory.lastProcess.options.provider).toBe('gemini');
    });

    test('resolves Codex model ID correctly', async () => {
      await orchestrator.startAgent(
        baseOpts({
          provider: 'codex',
          model: 'o4-mini',
        }),
      );

      expect(factory.lastProcess.options.model).toBe('o4-mini');
      expect(factory.lastProcess.options.provider).toBe('codex');
    });

    test('Gemini has no permission mode', async () => {
      await orchestrator.startAgent(
        baseOpts({
          provider: 'gemini',
          model: 'gemini-2.5-flash',
        }),
      );

      expect(factory.lastProcess.options.permissionMode).toBeUndefined();
    });

    test('uses provider-specific default tools', async () => {
      await orchestrator.startAgent(
        baseOpts({
          provider: 'gemini',
          model: 'gemini-2.5-flash',
        }),
      );

      // Gemini has no default tools (managed by ACP)
      expect(factory.lastProcess.options.allowedTools).toEqual([]);
    });
  });
});
