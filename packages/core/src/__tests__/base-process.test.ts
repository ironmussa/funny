import { BaseAgentProcess } from '../agents/base-process.js';
import type {
  ClaudeProcessOptions,
  CLIMessage,
  CLISystemMessage,
  CLIResultMessage,
} from '../agents/types.js';

// ── Concrete test implementation ────────────────────────────────

class TestProcess extends BaseAgentProcess {
  public runProcessFn: (() => Promise<void>) | null = null;
  public runProcessCalled = false;
  public runOnePromptFn: ((prompt: string, images?: unknown[]) => Promise<void>) | null = null;
  public runOnePromptCalls: Array<{ prompt: string; images?: unknown[] }> = [];

  protected async runProcess(): Promise<void> {
    this.runProcessCalled = true;
    if (this.runProcessFn) {
      await this.runProcessFn();
    }
  }

  protected async runOnePrompt(prompt: string, images?: unknown[]): Promise<void> {
    this.runOnePromptCalls.push({ prompt, images });
    if (this.runOnePromptFn) await this.runOnePromptFn(prompt, images);
  }

  // Expose protected helpers for testing
  public callEmitInit(sessionId: string, tools: string[], model: string, cwd: string): void {
    this.emitInit(sessionId, tools, model, cwd);
  }

  public callEmitResult(params: Parameters<BaseAgentProcess['emitResult']>[0]): void {
    this.emitResult(params);
  }

  public callFinalize(): void {
    this.finalize();
  }

  public getIsAborted(): boolean {
    return this.isAborted;
  }

  public callExtractErrorMessage(err: unknown): string {
    return this.extractErrorMessage(err);
  }

  public async callEnqueuePrompt(prompt: string, images?: unknown[]): Promise<void> {
    return this.enqueuePrompt(prompt, images);
  }
}

function createOptions(overrides?: Partial<ClaudeProcessOptions>): ClaudeProcessOptions {
  return {
    prompt: 'test prompt',
    cwd: '/tmp/test',
    model: 'test-model',
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────

describe('BaseAgentProcess', () => {
  let proc: TestProcess;

  beforeEach(() => {
    proc = new TestProcess(createOptions());
  });

  // ── Lifecycle ──────────────────────────────────────────────

  describe('lifecycle', () => {
    test('exited is false initially', () => {
      expect(proc.exited).toBe(false);
    });

    test('isAborted is false initially', () => {
      expect(proc.getIsAborted()).toBe(false);
    });

    test('start() calls runProcess()', () => {
      proc.start();
      // runProcess is async, give it a tick
      expect(proc.runProcessCalled).toBe(true);
    });

    test('kill() sets isAborted to true', async () => {
      await proc.kill();
      expect(proc.getIsAborted()).toBe(true);
    });

    test('finalize() sets exited to true and emits exit event', () => {
      const events: (number | null)[] = [];
      proc.on('exit', (code) => events.push(code));

      proc.callFinalize();

      expect(proc.exited).toBe(true);
      expect(events).toEqual([0]);
    });

    test('finalize() emits exit with null when aborted', async () => {
      const events: (number | null)[] = [];
      proc.on('exit', (code) => events.push(code));

      await proc.kill();
      proc.callFinalize();

      expect(events).toEqual([null]);
    });

    test('start() emits error if runProcess throws', async () => {
      const errors: Error[] = [];
      proc.on('error', (err) => errors.push(err));

      proc.runProcessFn = async () => {
        throw new Error('SDK crash');
      };
      proc.start();

      // Wait for async to complete
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(errors).toHaveLength(1);
      expect(errors[0].message).toBe('SDK crash');
    });

    test('start() does not emit error if already exited', async () => {
      const errors: Error[] = [];
      proc.on('error', (err) => errors.push(err));

      proc.runProcessFn = async () => {
        proc.callFinalize(); // marks as exited
        throw new Error('late error');
      };
      proc.start();

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(errors).toHaveLength(0);
    });

    test('start() wraps non-Error throws into Error', async () => {
      const errors: Error[] = [];
      proc.on('error', (err) => errors.push(err));

      proc.runProcessFn = async () => {
        throw 'string error';
      };
      proc.start();

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(errors).toHaveLength(1);
      expect(errors[0]).toBeInstanceOf(Error);
      expect(errors[0].message).toBe('string error');
    });
  });

  // ── emitInit ──────────────────────────────────────────────

  describe('emitInit', () => {
    test('emits a CLISystemMessage with correct fields', () => {
      const messages: CLIMessage[] = [];
      proc.on('message', (msg) => messages.push(msg));

      proc.callEmitInit('sess-123', ['Read', 'Edit'], 'claude-sonnet', '/project');

      expect(messages).toHaveLength(1);
      const msg = messages[0] as CLISystemMessage;
      expect(msg.type).toBe('system');
      expect(msg.subtype).toBe('init');
      expect(msg.session_id).toBe('sess-123');
      expect(msg.tools).toEqual(['Read', 'Edit']);
      expect(msg.model).toBe('claude-sonnet');
      expect(msg.cwd).toBe('/project');
    });

    test('emits with empty tools array', () => {
      const messages: CLIMessage[] = [];
      proc.on('message', (msg) => messages.push(msg));

      proc.callEmitInit('sess-1', [], 'model', '/cwd');

      const msg = messages[0] as CLISystemMessage;
      expect(msg.tools).toEqual([]);
    });
  });

  // ── emitResult ────────────────────────────────────────────

  describe('emitResult', () => {
    test('emits a success result', () => {
      const messages: CLIMessage[] = [];
      proc.on('message', (msg) => messages.push(msg));

      const startTime = Date.now() - 5000;
      proc.callEmitResult({
        sessionId: 'sess-abc',
        subtype: 'success',
        startTime,
        numTurns: 3,
        totalCost: 0.05,
        result: 'Done!',
      });

      expect(messages).toHaveLength(1);
      const msg = messages[0] as CLIResultMessage;
      expect(msg.type).toBe('result');
      expect(msg.subtype).toBe('success');
      expect(msg.is_error).toBe(false);
      expect(msg.num_turns).toBe(3);
      expect(msg.total_cost_usd).toBe(0.05);
      expect(msg.result).toBe('Done!');
      expect(msg.session_id).toBe('sess-abc');
      expect(msg.duration_ms).toBeGreaterThanOrEqual(4900);
    });

    test('emits an error result with is_error true', () => {
      const messages: CLIMessage[] = [];
      proc.on('message', (msg) => messages.push(msg));

      proc.callEmitResult({
        sessionId: 'sess-err',
        subtype: 'error_during_execution',
        startTime: Date.now(),
        numTurns: 1,
        totalCost: 0.01,
        result: 'Something failed',
        errors: ['Something failed'],
      });

      const msg = messages[0] as CLIResultMessage;
      expect(msg.is_error).toBe(true);
      expect(msg.subtype).toBe('error_during_execution');
      expect(msg.errors).toEqual(['Something failed']);
    });

    test('emits error_max_turns result', () => {
      const messages: CLIMessage[] = [];
      proc.on('message', (msg) => messages.push(msg));

      proc.callEmitResult({
        sessionId: 'sess-mt',
        subtype: 'error_max_turns',
        startTime: Date.now(),
        numTurns: 200,
        totalCost: 1.5,
      });

      const msg = messages[0] as CLIResultMessage;
      expect(msg.is_error).toBe(true);
      expect(msg.subtype).toBe('error_max_turns');
    });

    test('omits errors field when not provided', () => {
      const messages: CLIMessage[] = [];
      proc.on('message', (msg) => messages.push(msg));

      proc.callEmitResult({
        sessionId: 's',
        subtype: 'success',
        startTime: Date.now(),
        numTurns: 1,
        totalCost: 0,
      });

      const msg = messages[0] as CLIResultMessage;
      expect(msg.errors).toBeUndefined();
    });
  });

  // ── extractErrorMessage ────────────────────────────────────

  describe('extractErrorMessage', () => {
    test('returns message from a plain Error', () => {
      expect(proc.callExtractErrorMessage(new Error('something broke'))).toBe('something broke');
    });

    test('extracts details from ACP RequestError-shaped object', () => {
      const acpError = {
        message: 'Internal error',
        code: -32603,
        data: {
          details:
            'Unable to infer model provider for { model: google:gemini-3-flash-preview }, please specify modelProvider directly.',
        },
      };
      expect(proc.callExtractErrorMessage(acpError)).toBe(
        'Unable to infer model provider for { model: google:gemini-3-flash-preview }, please specify modelProvider directly.',
      );
    });

    test('falls back to message when data has no details', () => {
      const err = { message: 'Internal error', code: -32603, data: { other: 'info' } };
      expect(proc.callExtractErrorMessage(err)).toBe('Internal error');
    });

    test('handles null input', () => {
      expect(proc.callExtractErrorMessage(null)).toBe('Unknown error');
    });

    test('handles undefined input', () => {
      expect(proc.callExtractErrorMessage(undefined)).toBe('Unknown error');
    });

    test('handles string input', () => {
      expect(proc.callExtractErrorMessage('raw string error')).toBe('raw string error');
    });
  });

  // ── enqueuePrompt (fire-and-forget) ───────────────────────
  //
  // Regression: HTTP `POST /messages` previously blocked for the entire
  // turn because enqueuePrompt awaited the turn completion. That caused
  // WS tunnel timeouts (30s) and duplicate POSTs for any provider whose
  // sendPrompt awaited the full turn (Gemini ACP / Codex / Pi).
  describe('enqueuePrompt', () => {
    test('returns before the turn completes (fire-and-forget)', async () => {
      let resolveTurn!: () => void;
      proc.runOnePromptFn = () =>
        new Promise((resolve) => {
          resolveTurn = resolve;
        });

      const t0 = Date.now();
      await proc.callEnqueuePrompt('hello');
      const elapsed = Date.now() - t0;

      // Resolved without waiting for the turn.
      expect(elapsed).toBeLessThan(50);
      expect(proc.runOnePromptCalls).toEqual([{ prompt: 'hello', images: undefined }]);

      // Cleanup so the test doesn't leak the pending promise.
      resolveTurn();
    });

    test('queues subsequent prompts while a turn is in flight, drains in order', async () => {
      const releases: Array<() => void> = [];
      proc.runOnePromptFn = () =>
        new Promise<void>((resolve) => {
          releases.push(resolve);
        });

      await proc.callEnqueuePrompt('first');
      await proc.callEnqueuePrompt('second');
      await proc.callEnqueuePrompt('third');

      // Only the first turn is running; rest are queued.
      expect(proc.runOnePromptCalls.map((c) => c.prompt)).toEqual(['first']);

      releases[0]();
      await new Promise((r) => setTimeout(r, 0));
      expect(proc.runOnePromptCalls.map((c) => c.prompt)).toEqual(['first', 'second']);

      releases[1]();
      await new Promise((r) => setTimeout(r, 0));
      expect(proc.runOnePromptCalls.map((c) => c.prompt)).toEqual(['first', 'second', 'third']);

      releases[2]();
    });

    test('throws when the process has exited', async () => {
      proc.callFinalize();
      await expect(proc.callEnqueuePrompt('x')).rejects.toThrow('Agent process has exited');
    });

    test('a failing turn does not poison the queue', async () => {
      const errors: Error[] = [];
      proc.on('error', (err) => errors.push(err));

      let attempts = 0;
      proc.runOnePromptFn = async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('boom');
      };

      await proc.callEnqueuePrompt('a');
      await proc.callEnqueuePrompt('b');

      // Let microtasks flush.
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));

      expect(proc.runOnePromptCalls.map((c) => c.prompt)).toEqual(['a', 'b']);
      expect(errors.map((e) => e.message)).toEqual(['boom']);
    });
  });
});
