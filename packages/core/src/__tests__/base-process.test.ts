import { describe, test, expect, beforeEach } from 'vitest';

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

  protected async runProcess(): Promise<void> {
    this.runProcessCalled = true;
    if (this.runProcessFn) {
      await this.runProcessFn();
    }
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
});
