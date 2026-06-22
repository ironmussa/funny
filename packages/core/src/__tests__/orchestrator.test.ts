import { EventEmitter } from 'events';

import type {
  IAgentProcess,
  IAgentProcessFactory,
  AgentProcessOptions,
} from '../agents/interfaces.js';
import {
  AgentOrchestrator,
  buildEffectivePrompt,
  DEFAULT_RESUME_PREFIX,
  extractSlashCommandName,
  type IdleReapPolicy,
  isPureSlashCommand,
} from '../agents/orchestrator.js';
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

  simulateSessionInvalidated(): void {
    this.emit('session-invalidated');
  }
}

// ── Silent mock that does NOT emit init on start ────────────────

class SilentMockProcess extends MockProcess {
  start(): void {
    this.started = true;
    // Intentionally does NOT emit any message
  }
}

// ── Steerable mock (live multi-turn) ────────────────────────────
// Implements sendPrompt + steerPrompt and stays alive after start, so the
// orchestrator's warm-reuse / steer branches engage (mirrors a steerable
// SDKClaudeProcess).

class SteerableMockProcess extends MockProcess {
  public sendPromptCalls: string[] = [];
  public steerPromptCalls: string[] = [];

  async sendPrompt(prompt: string): Promise<void> {
    this.sendPromptCalls.push(prompt);
  }

  async steerPrompt(prompt: string): Promise<void> {
    this.steerPromptCalls.push(prompt);
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

describe('isPureSlashCommand', () => {
  test.each([
    '/compact',
    '/clear',
    '/compact keep the API-design notes',
    '  /compact  ',
    '/opsx:apply',
    '/skill-creator:skill-creator make a thing',
  ])('detects %j as a slash command', (p) => expect(isPureSlashCommand(p)).toBe(true));

  test.each([
    'please /compact this',
    'read /etc/hosts',
    '/home/user/file.ts',
    '//comment',
    '/123abc',
    '/opsx:/apply',
    'compact',
    '',
  ])('does NOT treat %j as a slash command', (p) => expect(isPureSlashCommand(p)).toBe(false));
});

describe('extractSlashCommandName', () => {
  test.each([
    ['/compact', 'compact'],
    ['/compact keep the API-design notes', 'compact'],
    ['  /context  ', 'context'],
    ['/model opus', 'model'],
    ['/opsx:apply', 'opsx:apply'],
    ['/skill-creator:skill-creator make a thing', 'skill-creator:skill-creator'],
  ])('extracts the command name from %j', (input, expected) =>
    expect(extractSlashCommandName(input)).toBe(expected),
  );

  test.each(['please /compact', '/home/user/file.ts', '/123', '/opsx:/apply', '', 'compact'])(
    'returns null for %j',
    (p) => expect(extractSlashCommandName(p)).toBeNull(),
  );
});

describe('buildEffectivePrompt', () => {
  test('prepends the resume prefix to a normal resumed prompt', () => {
    const out = buildEffectivePrompt('keep going', { isResume: true });
    expect(out).toBe(`${DEFAULT_RESUME_PREFIX}\n\nkeep going`);
  });

  test('uses the caller-supplied resumePrefix when provided', () => {
    const out = buildEffectivePrompt('keep going', { isResume: true, resumePrefix: '[PREFIX]' });
    expect(out).toBe('[PREFIX]\n\nkeep going');
  });

  test('leaves a slash command verbatim on resume (the bug fix)', () => {
    expect(
      buildEffectivePrompt('/compact', { isResume: true, resumePrefix: '[PREVIEWABLE]' }),
    ).toBe('/compact');
  });

  test('never prefixes when not resuming', () => {
    expect(buildEffectivePrompt('hello', { isResume: false })).toBe('hello');
  });
});

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

    test('emits agent:session-cleared when fresh process reports session-invalidated', async () => {
      const clearedSessions: string[] = [];
      orchestrator.on('agent:session-cleared', (id) => clearedSessions.push(id));

      await orchestrator.startAgent(baseOpts());
      factory.lastProcess.simulateSessionInvalidated();

      expect(clearedSessions).toEqual(['t1']);
    });

    test('kills existing process before starting new one', async () => {
      await orchestrator.startAgent(baseOpts());
      const first = factory.lastProcess;

      await orchestrator.startAgent(baseOpts({ prompt: 'second' }));

      expect(first.exited).toBe(true);
      expect(factory.lastProcess).not.toBe(first);
    });

    test('does not let a stopped previous process suppress replacement results', async () => {
      const results: CLIMessage[] = [];
      orchestrator.on('agent:message', (_id, msg) => {
        if (msg.type === 'result') results.push(msg);
      });

      await orchestrator.startAgent(baseOpts());
      const first = factory.lastProcess;

      await orchestrator.startAgent(baseOpts({ prompt: 'second' }));
      const second = factory.lastProcess;

      expect(second).not.toBe(first);

      second.simulateMessage({
        type: 'result',
        subtype: 'success',
        is_error: false,
        duration_ms: 5000,
        num_turns: 1,
        total_cost_usd: 0.01,
        session_id: 'sess-2',
      });

      expect(results).toHaveLength(1);
      expect(results[0]?.session_id).toBe('sess-2');
    });

    test('ignores stale messages from a replaced process', async () => {
      const results: CLIMessage[] = [];
      orchestrator.on('agent:message', (_id, msg) => {
        if (msg.type === 'result') results.push(msg);
      });

      await orchestrator.startAgent(baseOpts());
      const first = factory.lastProcess;

      await orchestrator.startAgent(baseOpts({ prompt: 'second' }));

      // The old process can exit after the replacement is already active.
      first.simulateExit(undefined as unknown as number | null);
      first.simulateMessage({
        type: 'result',
        subtype: 'success',
        is_error: false,
        duration_ms: 5000,
        num_turns: 1,
        total_cost_usd: 0.01,
        session_id: 'stale-sess',
      });

      expect(results).toHaveLength(0);
      expect(orchestrator.isRunning('t1')).toBe(true);
    });

    test('passes resolved model ID to process', async () => {
      await orchestrator.startAgent(baseOpts({ model: 'opus' }));

      expect(factory.lastProcess.options.model).toBe('claude-opus-4-6[1m]');
    });

    test('passes permission mode to process', async () => {
      await orchestrator.startAgent(baseOpts({ permissionMode: 'autoEdit' }));

      expect(factory.lastProcess.options.permissionMode).toBe('bypassPermissions');
    });

    test('forwards fastMode to process options', async () => {
      await orchestrator.startAgent(baseOpts({ fastMode: true }));

      expect(factory.lastProcess.options.fastMode).toBe(true);
    });

    test('forwards steerable to process options', async () => {
      await orchestrator.startAgent(baseOpts({ steerable: true }));

      expect(factory.lastProcess.options.steerable).toBe(true);
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

  // ── Steering (live multi-turn) ─────────────────────────────────

  describe('steering', () => {
    let steerFactory: ReturnType<typeof createFactory>;
    let orch: AgentOrchestrator;

    beforeEach(() => {
      steerFactory = createFactory(SteerableMockProcess);
      orch = new AgentOrchestrator(steerFactory);
    });

    test('steer redirects the live turn via steerPrompt without respawning', async () => {
      await orch.startAgent(baseOpts({ steerable: true }));
      const proc = steerFactory.lastProcess as SteerableMockProcess;

      await orch.startAgent(baseOpts({ steerable: true, steer: true, prompt: 'redirect' }));

      expect(proc.steerPromptCalls).toEqual(['redirect']);
      expect(proc.sendPromptCalls).toEqual([]);
      // Same live process — no kill + respawn (partial output preserved).
      expect(steerFactory.lastProcess).toBe(proc);
      expect(proc.exited).toBe(false);
    });

    test('non-steer follow-up warm-continues the live session via sendPrompt', async () => {
      await orch.startAgent(baseOpts({ steerable: true }));
      const proc = steerFactory.lastProcess as SteerableMockProcess;

      await orch.startAgent(baseOpts({ steerable: true, prompt: 'follow up' }));

      expect(proc.sendPromptCalls).toEqual(['follow up']);
      expect(proc.steerPromptCalls).toEqual([]);
      expect(steerFactory.lastProcess).toBe(proc);
    });

    test('incompatible options force a respawn instead of steering', async () => {
      await orch.startAgent(baseOpts({ steerable: true }));
      const first = steerFactory.lastProcess as SteerableMockProcess;

      // Switching model breaks the reuse-compatibility snapshot.
      await orch.startAgent(baseOpts({ steerable: true, steer: true, model: 'haiku' }));

      expect(first.steerPromptCalls).toEqual([]);
      expect(first.exited).toBe(true);
      expect(steerFactory.lastProcess).not.toBe(first);
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

    // Regression: a slash command (/compact, /clear, …) must reach the SDK CLI
    // raw — with the command as the very first characters — or the CLI forwards
    // it to the model as literal text and never actually runs the command (so
    // /compact never compacts and the context-usage ring stays frozen). The
    // resume prefix (or systemPrefix) must NOT be prepended to it.
    test('does NOT prepend resume prefix to a slash command', async () => {
      await orchestrator.startAgent(
        baseOpts({
          sessionId: 'sess-old',
          prompt: '/compact',
          systemPrefix: '[PREVIEWABLE ASSETS]…',
        }),
      );

      expect(factory.lastProcess.options.prompt).toBe('/compact');
      expect(factory.lastProcess.options.prompt).not.toContain('[SYSTEM NOTE:');
      expect(factory.lastProcess.options.prompt).not.toContain('[PREVIEWABLE ASSETS]');
      expect(factory.lastProcess.options.sessionId).toBe('sess-old');
    });

    test('still prefixes a normal prompt that merely contains a slash', async () => {
      await orchestrator.startAgent(
        baseOpts({ sessionId: 'sess-old', prompt: 'please read /etc/hosts and summarize' }),
      );

      expect(factory.lastProcess.options.prompt).toContain('[SYSTEM NOTE:');
      expect(factory.lastProcess.options.prompt).toContain('please read /etc/hosts');
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

    test('emits agent:session-cleared when resume process reports session-invalidated', async () => {
      const clearedSessions: string[] = [];
      orchestrator.on('agent:session-cleared', (id) => clearedSessions.push(id));

      await orchestrator.startAgent(baseOpts({ sessionId: 'poisoned-sess' }));
      const proc = factory.lastProcess;

      proc.simulateSessionInvalidated();

      expect(clearedSessions).toEqual(['t1']);
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
          model: 'gpt-5.4',
        }),
      );

      expect(factory.lastProcess.options.model).toBe('gpt-5.4');
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

  // ── Idle reaping ───────────────────────────────────────────────

  describe('idle reaping', () => {
    const POLICY: IdleReapPolicy = { defaultIdleMs: 10_000, claudeIdleMs: 0 };
    const result = () => ({ type: 'result', subtype: 'success' }) as unknown as CLIMessage;

    test('3.1 reaps an idle, turn-terminal non-claude agent past the window', async () => {
      await orchestrator.startAgent(baseOpts({ provider: 'codex', model: 'gpt-5.5' }));
      factory.lastProcess.simulateMessage(result());

      expect(orchestrator.getIdleCandidates(Date.now() + 10_001, POLICY)).toContain('t1');

      const proc = factory.lastProcess;
      await orchestrator.reapIdleAgent('t1');
      expect(proc.exited).toBe(true);
      expect(orchestrator.isRunning('t1')).toBe(false);
    });

    test('3.2 never reaps a mid-turn agent (no terminal result)', async () => {
      await orchestrator.startAgent(baseOpts({ provider: 'codex', model: 'gpt-5.5' }));
      factory.lastProcess.simulateMessage({ type: 'assistant' } as unknown as CLIMessage);

      expect(orchestrator.getIdleCandidates(Date.now() + 1_000_000, POLICY)).toEqual([]);
    });

    test('3.3 never reaps an agent awaiting a permission decision (no result)', async () => {
      await orchestrator.startAgent(baseOpts({ provider: 'codex', model: 'gpt-5.5' }));
      // Turn paused on a permission prompt → no result emitted, so not terminal.
      expect(orchestrator.getIdleCandidates(Date.now() + 1_000_000, POLICY)).toEqual([]);
    });

    test('3.4 claude with a disabled window is not reaped; codex is', async () => {
      await orchestrator.startAgent(baseOpts({ threadId: 'tc', provider: 'claude' }));
      const pc = factory.lastProcess;
      pc.simulateMessage(result());

      await orchestrator.startAgent(
        baseOpts({ threadId: 'tx', provider: 'codex', model: 'gpt-5.5' }),
      );
      const px = factory.lastProcess;
      px.simulateMessage(result());

      const candidates = orchestrator.getIdleCandidates(Date.now() + 10_001, POLICY);
      expect(candidates).toContain('tx');
      expect(candidates).not.toContain('tc');
    });

    test('3.5 adopted process is seeded as active and not reaped immediately', async () => {
      const proc = new MockProcess(baseOpts({ provider: 'codex' }) as any);
      orchestrator.adoptProcess('t-adopt', proc);
      proc.simulateMessage(result());

      // Checked 1s later against a 10-min window → still fresh, not a candidate.
      expect(
        orchestrator.getIdleCandidates(Date.now() + 1_000, {
          defaultIdleMs: 600_000,
          claudeIdleMs: 0,
        }),
      ).toEqual([]);
    });

    test('3.6 reap is non-destructive and distinguishable from a stop', async () => {
      const events: Array<[string, unknown[]]> = [];
      orchestrator.on('agent:reaped', (...a) => events.push(['reaped', a]));
      orchestrator.on('agent:stopped', (...a) => events.push(['stopped', a]));
      orchestrator.on('agent:session-cleared', (...a) => events.push(['cleared', a]));

      await orchestrator.startAgent(baseOpts({ provider: 'codex', model: 'gpt-5.5' }));
      factory.lastProcess.simulateMessage(result());

      await orchestrator.reapIdleAgent('t1');

      const kinds = events.map((e) => e[0]);
      expect(kinds).toContain('reaped');
      expect(kinds).not.toContain('stopped');
      expect(kinds).not.toContain('cleared');

      // Payload is (threadId, provider, idleMs).
      const reaped = events.find((e) => e[0] === 'reaped')!;
      expect(reaped[1][0]).toBe('t1');
      expect(reaped[1][1]).toBe('codex');
      expect(typeof reaped[1][2]).toBe('number');
    });
  });
});
