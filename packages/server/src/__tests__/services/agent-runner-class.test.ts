import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { EventEmitter } from 'events';
import { AgentRunner } from '../../services/agent-runner.js';
import type { IClaudeProcess, IClaudeProcessFactory, CLIMessage, CLIAssistantMessage, CLIResultMessage, CLISystemMessage, CLIUserMessage } from '@funny/core/agents';
import type { IThreadManager, IWSBroker } from '../../services/server-interfaces.js';
import type { WSEvent } from '@funny/shared';

// ── Mock helpers ────────────────────────────────────────────────

class MockClaudeProcess extends EventEmitter implements IClaudeProcess {
  private _exited = false;
  started = false;

  start(): void {
    this.started = true;
    // Emit a synthetic init message synchronously so the orchestrator's
    // resume-check promise resolves immediately (its handlers are already
    // wired before start() is called) instead of waiting 3 seconds.
    this.emit('message', {
      type: 'system',
      subtype: 'init',
      session_id: 'mock-sess',
      tools: [],
      cwd: '/tmp',
    });
  }

  async kill(): Promise<void> {
    // In real ClaudeProcess, kill() sends SIGTERM and the exit event fires
    // asynchronously from the process's .exited Promise handler.
    // We intentionally do NOT emit 'exit' here — tests call simulateExit()
    // to model the delayed process exit.
    this._exited = true;
  }

  get exited(): boolean {
    return this._exited;
  }

  /** Simulate the process emitting a message */
  simulateMessage(msg: CLIMessage): void {
    this.emit('message', msg);
  }

  /** Simulate the process exiting */
  simulateExit(code: number | null = 0): void {
    this._exited = true;
    this.emit('exit', code);
  }

  /** Simulate an error */
  simulateError(err: Error): void {
    this.emit('error', err);
  }
}

function createMockThreadManager(): IThreadManager & {
  threads: Map<string, any>;
  messages: Map<string, any>;
  toolCalls: Map<string, any>;
  _nextId: number;
} {
  const threads = new Map<string, any>();
  const messages = new Map<string, any>();
  const toolCalls = new Map<string, any>();
  let _nextId = 1;

  return {
    threads,
    messages,
    toolCalls,
    _nextId,

    getThread(id: string) {
      return threads.get(id);
    },
    updateThread(id: string, updates: Record<string, any>) {
      const existing = threads.get(id) || {};
      threads.set(id, { ...existing, id, ...updates });
    },
    insertMessage(data) {
      const id = `msg-${_nextId++}`;
      messages.set(id, { id, ...data });
      return id;
    },
    updateMessage(id: string, content: string) {
      const existing = messages.get(id);
      if (existing) messages.set(id, { ...existing, content });
    },
    insertToolCall(data) {
      const id = `tc-${_nextId++}`;
      toolCalls.set(id, { id, ...data });
      return id;
    },
    updateToolCallOutput(id: string, output: string) {
      const existing = toolCalls.get(id);
      if (existing) toolCalls.set(id, { ...existing, output });
    },
    findToolCall(messageId: string, name: string, input: string) {
      for (const tc of toolCalls.values()) {
        if (tc.messageId === messageId && tc.name === name && tc.input === input) {
          return { id: tc.id };
        }
      }
      return undefined;
    },
    getToolCall(id: string) {
      const tc = toolCalls.get(id);
      if (!tc) return undefined;
      return { id: tc.id, name: tc.name, input: tc.input ?? null, output: tc.output ?? null };
    },
    getThreadWithMessages(id: string) {
      const thread = threads.get(id);
      if (!thread) return null;
      const msgs = Array.from(messages.values()).filter((m: any) => m.threadId === id);
      return { ...thread, messages: msgs };
    },
  };
}

function createMockWSBroker(): IWSBroker & { events: WSEvent[] } {
  const events: WSEvent[] = [];
  return {
    events,
    emit(event: WSEvent) {
      events.push(event);
    },
    emitToUser(_userId: string, event: WSEvent) {
      events.push(event);
    },
  };
}

// ── Tests ───────────────────────────────────────────────────────

describe('AgentRunner class', () => {
  let runner: AgentRunner;
  let tmMock: ReturnType<typeof createMockThreadManager>;
  let wsMock: ReturnType<typeof createMockWSBroker>;
  let lastProcess: MockClaudeProcess;
  let factory: IClaudeProcessFactory;

  beforeEach(() => {
    tmMock = createMockThreadManager();
    wsMock = createMockWSBroker();
    lastProcess = null as any;
    factory = {
      create(_opts) {
        lastProcess = new MockClaudeProcess();
        return lastProcess;
      },
    };
    runner = new AgentRunner(tmMock, wsMock, factory, () => undefined);
  });

  // ── startAgent ──────────────────────────────────────────────

  describe('startAgent', () => {
    test('sets thread status to running and creates user message', async () => {
      tmMock.threads.set('t1', { sessionId: null });

      await runner.startAgent('t1', 'Fix the bug', '/tmp/repo');

      expect(tmMock.threads.get('t1')?.status).toBe('running');
      expect(lastProcess.started).toBe(true);

      // Should have a user message
      const userMsgs = [...tmMock.messages.values()].filter(m => m.role === 'user');
      expect(userMsgs).toHaveLength(1);
      expect(userMsgs[0].content).toBe('Fix the bug');
    });

    test('emits agent:status running via WebSocket', async () => {
      tmMock.threads.set('t1', { sessionId: null });

      await runner.startAgent('t1', 'test', '/tmp');

      const statusEvents = wsMock.events.filter(e => e.type === 'agent:status');
      expect(statusEvents).toHaveLength(1);
      expect(statusEvents[0].data).toEqual({ status: 'running' });
    });

    test('passes session ID for resume when thread has one', async () => {
      tmMock.threads.set('t1', { sessionId: 'sess-abc' });

      let capturedOpts: any = null;
      factory.create = (opts) => {
        capturedOpts = opts;
        lastProcess = new MockClaudeProcess();
        return lastProcess;
      };

      await runner.startAgent('t1', 'continue', '/tmp');

      expect(capturedOpts.sessionId).toBe('sess-abc');
    });

    test('stops existing agent before starting a new one', async () => {
      tmMock.threads.set('t1', { sessionId: null });

      await runner.startAgent('t1', 'first', '/tmp');
      const firstProc = lastProcess;

      await runner.startAgent('t1', 'second', '/tmp');

      expect(firstProc.exited).toBe(true);
      expect(lastProcess).not.toBe(firstProc);
      expect(lastProcess.started).toBe(true);
    });

    test('stores images as JSON string in user message', async () => {
      tmMock.threads.set('t1', { sessionId: null });
      const images = [{ type: 'image', source: { type: 'base64', data: 'abc' } }];

      await runner.startAgent('t1', 'describe image', '/tmp', 'sonnet', 'autoEdit', images);

      const userMsgs = [...tmMock.messages.values()].filter(m => m.role === 'user');
      expect(userMsgs[0].images).toBe(JSON.stringify(images));
    });
  });

  // ── handleCLIMessage: system init ───────────────────────────

  describe('handleCLIMessage — system init', () => {
    test('saves session_id and emits agent:init', async () => {
      tmMock.threads.set('t1', { sessionId: null });
      await runner.startAgent('t1', 'test', '/tmp');
      wsMock.events.length = 0;

      const msg: CLISystemMessage = {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-xyz',
        tools: ['Read', 'Edit'],
        model: 'claude-sonnet-4-5-20250929',
        cwd: '/tmp',
      };

      lastProcess.simulateMessage(msg);

      expect(tmMock.threads.get('t1')?.sessionId).toBe('sess-xyz');

      const initEvents = wsMock.events.filter(e => e.type === 'agent:init');
      expect(initEvents).toHaveLength(1);
      expect(initEvents[0].data).toEqual({
        tools: ['Read', 'Edit'],
        cwd: '/tmp',
        model: 'claude-sonnet-4-5-20250929',
      });
    });
  });

  // ── handleCLIMessage: assistant text ────────────────────────

  describe('handleCLIMessage — assistant text', () => {
    test('inserts a new message on first text', async () => {
      tmMock.threads.set('t1', { sessionId: null });
      await runner.startAgent('t1', 'test', '/tmp');
      wsMock.events.length = 0;
      const startupMsgCount = tmMock.messages.size;

      const msg: CLIAssistantMessage = {
        type: 'assistant',
        message: {
          id: 'cli-msg-1',
          content: [{ type: 'text', text: 'Hello' }],
        },
      };

      lastProcess.simulateMessage(msg);

      const msgs = [...tmMock.messages.values()];
      expect(msgs).toHaveLength(startupMsgCount + 1);
      const lastMsg = msgs[msgs.length - 1];
      expect(lastMsg.role).toBe('assistant');
      expect(lastMsg.content).toBe('Hello');

      const wsMsg = wsMock.events.find(e => e.type === 'agent:message');
      expect(wsMsg).toBeTruthy();
      expect(wsMsg!.data).toMatchObject({ role: 'assistant', content: 'Hello' });
    });

    test('updates existing message on cumulative streaming', async () => {
      tmMock.threads.set('t1', { sessionId: null });
      await runner.startAgent('t1', 'test', '/tmp');
      const startupMsgCount = tmMock.messages.size;

      const msg1: CLIAssistantMessage = {
        type: 'assistant',
        message: {
          id: 'cli-msg-1',
          content: [{ type: 'text', text: 'Hel' }],
        },
      };
      const msg2: CLIAssistantMessage = {
        type: 'assistant',
        message: {
          id: 'cli-msg-1',
          content: [{ type: 'text', text: 'Hello world' }],
        },
      };

      lastProcess.simulateMessage(msg1);
      lastProcess.simulateMessage(msg2);

      // Should only have 1 new message, not 2
      const msgs = [...tmMock.messages.values()];
      expect(msgs).toHaveLength(startupMsgCount + 1);
      expect(msgs[msgs.length - 1].content).toBe('Hello world');
    });

    test('combines multiple text blocks into one', async () => {
      tmMock.threads.set('t1', { sessionId: null });
      await runner.startAgent('t1', 'test', '/tmp');

      const msg: CLIAssistantMessage = {
        type: 'assistant',
        message: {
          id: 'cli-msg-1',
          content: [
            { type: 'text', text: 'First paragraph' },
            { type: 'text', text: 'Second paragraph' },
          ],
        },
      };

      lastProcess.simulateMessage(msg);

      const msgs = [...tmMock.messages.values()];
      expect(msgs[msgs.length - 1].content).toBe('First paragraph\n\nSecond paragraph');
    });

    test('decodes Unicode escapes in text', async () => {
      tmMock.threads.set('t1', { sessionId: null });
      await runner.startAgent('t1', 'test', '/tmp');

      const msg: CLIAssistantMessage = {
        type: 'assistant',
        message: {
          id: 'cli-msg-1',
          content: [{ type: 'text', text: 'caf\\u00e9' }],
        },
      };

      lastProcess.simulateMessage(msg);

      const msgs = [...tmMock.messages.values()];
      expect(msgs[msgs.length - 1].content).toBe('café');
    });
  });

  // ── handleCLIMessage: tool_use ──────────────────────────────

  describe('handleCLIMessage — tool_use', () => {
    test('creates a tool call record and emits WS event', async () => {
      tmMock.threads.set('t1', { sessionId: null });
      await runner.startAgent('t1', 'test', '/tmp');
      wsMock.events.length = 0;

      const msg: CLIAssistantMessage = {
        type: 'assistant',
        message: {
          id: 'cli-msg-1',
          content: [
            { type: 'tool_use', id: 'tu-1', name: 'Read', input: { file: 'test.ts' } },
          ],
        },
      };

      lastProcess.simulateMessage(msg);

      const tcs = [...tmMock.toolCalls.values()];
      expect(tcs).toHaveLength(1);
      expect(tcs[0].name).toBe('Read');
      expect(JSON.parse(tcs[0].input)).toEqual({ file: 'test.ts' });

      const tcEvent = wsMock.events.find(e => e.type === 'agent:tool_call');
      expect(tcEvent).toBeTruthy();
      expect(tcEvent!.data).toMatchObject({ name: 'Read' });
    });

    test('deduplicates tool_use blocks with the same CLI ID', async () => {
      tmMock.threads.set('t1', { sessionId: null });
      await runner.startAgent('t1', 'test', '/tmp');

      const content = [
        { type: 'tool_use' as const, id: 'tu-1', name: 'Read', input: { file: 'a.ts' } },
      ];
      const msg1: CLIAssistantMessage = {
        type: 'assistant',
        message: { id: 'cli-msg-1', content },
      };
      const msg2: CLIAssistantMessage = {
        type: 'assistant',
        message: { id: 'cli-msg-1', content },
      };

      lastProcess.simulateMessage(msg1);
      lastProcess.simulateMessage(msg2);

      const tcs = [...tmMock.toolCalls.values()];
      expect(tcs).toHaveLength(1);
    });

    test('creates parent assistant message when no text preceded tool_use', async () => {
      tmMock.threads.set('t1', { sessionId: null });
      await runner.startAgent('t1', 'test', '/tmp');
      const startupMsgCount = tmMock.messages.size;

      const msg: CLIAssistantMessage = {
        type: 'assistant',
        message: {
          id: 'cli-msg-1',
          content: [
            { type: 'tool_use', id: 'tu-1', name: 'Glob', input: { pattern: '*.ts' } },
          ],
        },
      };

      lastProcess.simulateMessage(msg);

      // Should have an empty assistant message as parent (in addition to startup messages)
      const msgs = [...tmMock.messages.values()];
      expect(msgs).toHaveLength(startupMsgCount + 1);
      const lastMsg = msgs[msgs.length - 1];
      expect(lastMsg.role).toBe('assistant');
      expect(lastMsg.content).toBe('');
    });

    test('handles multiple tool_use blocks in one message', async () => {
      tmMock.threads.set('t1', { sessionId: null });
      await runner.startAgent('t1', 'test', '/tmp');

      const msg: CLIAssistantMessage = {
        type: 'assistant',
        message: {
          id: 'cli-msg-1',
          content: [
            { type: 'tool_use', id: 'tu-1', name: 'Read', input: { file: 'a.ts' } },
            { type: 'tool_use', id: 'tu-2', name: 'Edit', input: { file: 'b.ts' } },
          ],
        },
      };

      lastProcess.simulateMessage(msg);

      const tcs = [...tmMock.toolCalls.values()];
      expect(tcs).toHaveLength(2);
      expect(tcs.map(tc => tc.name)).toEqual(['Read', 'Edit']);
    });

    test('tracks AskUserQuestion as pending user input', async () => {
      tmMock.threads.set('t1', { sessionId: null });
      await runner.startAgent('t1', 'test', '/tmp');
      wsMock.events.length = 0;

      const msg: CLIAssistantMessage = {
        type: 'assistant',
        message: {
          id: 'cli-msg-1',
          content: [
            { type: 'text', text: 'I have a question' },
            { type: 'tool_use', id: 'tu-1', name: 'AskUserQuestion', input: { question: 'Which?' } },
          ],
        },
      };

      // We need a result after this to check the waiting status
      lastProcess.simulateMessage(msg);

      const resultMsg: CLIResultMessage = {
        type: 'result',
        subtype: 'success',
        is_error: false,
        duration_ms: 5000,
        num_turns: 1,
        total_cost_usd: 0.01,
        session_id: 'sess-1',
      };

      lastProcess.simulateMessage(resultMsg);

      expect(tmMock.threads.get('t1')?.status).toBe('waiting');
      const resultEvent = wsMock.events.find(e => e.type === 'agent:result');
      expect(resultEvent!.data).toMatchObject({ status: 'waiting', waitingReason: 'question' });
    });

    test('tracks ExitPlanMode as pending user input', async () => {
      tmMock.threads.set('t1', { sessionId: null });
      await runner.startAgent('t1', 'test', '/tmp');
      wsMock.events.length = 0;

      const msg: CLIAssistantMessage = {
        type: 'assistant',
        message: {
          id: 'cli-msg-1',
          content: [
            { type: 'tool_use', id: 'tu-1', name: 'ExitPlanMode', input: {} },
          ],
        },
      };

      lastProcess.simulateMessage(msg);

      const resultMsg: CLIResultMessage = {
        type: 'result',
        subtype: 'success',
        is_error: false,
        duration_ms: 3000,
        num_turns: 1,
        total_cost_usd: 0.02,
        session_id: 'sess-1',
      };

      lastProcess.simulateMessage(resultMsg);

      expect(tmMock.threads.get('t1')?.status).toBe('waiting');
      const resultEvent = wsMock.events.find(e => e.type === 'agent:result');
      expect(resultEvent!.data).toMatchObject({ waitingReason: 'plan' });
    });
  });

  // ── handleCLIMessage: user (tool results) ───────────────────

  describe('handleCLIMessage — user tool results', () => {
    test('updates tool call output and emits WS event', async () => {
      tmMock.threads.set('t1', { sessionId: null });
      await runner.startAgent('t1', 'test', '/tmp');
      wsMock.events.length = 0;

      // First, create a tool call via an assistant message
      const assistantMsg: CLIAssistantMessage = {
        type: 'assistant',
        message: {
          id: 'cli-msg-1',
          content: [
            { type: 'tool_use', id: 'tu-1', name: 'Read', input: { file: 'test.ts' } },
          ],
        },
      };
      lastProcess.simulateMessage(assistantMsg);

      const tcId = [...tmMock.toolCalls.values()][0].id;

      // Now send tool result
      const userMsg: CLIUserMessage = {
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tu-1', content: 'file contents here' },
          ],
        },
      };
      lastProcess.simulateMessage(userMsg);

      expect(tmMock.toolCalls.get(tcId)?.output).toBe('file contents here');

      const outputEvent = wsMock.events.find(e => e.type === 'agent:tool_output');
      expect(outputEvent).toBeTruthy();
      expect(outputEvent!.data).toMatchObject({ toolCallId: tcId, output: 'file contents here' });
    });

    test('decodes Unicode in tool output', async () => {
      tmMock.threads.set('t1', { sessionId: null });
      await runner.startAgent('t1', 'test', '/tmp');

      const assistantMsg: CLIAssistantMessage = {
        type: 'assistant',
        message: {
          id: 'cli-msg-1',
          content: [
            { type: 'tool_use', id: 'tu-1', name: 'Bash', input: { command: 'echo' } },
          ],
        },
      };
      lastProcess.simulateMessage(assistantMsg);

      const userMsg: CLIUserMessage = {
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tu-1', content: 'caf\\u00e9' },
          ],
        },
      };
      lastProcess.simulateMessage(userMsg);

      const tc = [...tmMock.toolCalls.values()][0];
      expect(tc.output).toBe('café');
    });
  });

  // ── handleCLIMessage: result ────────────────────────────────

  describe('handleCLIMessage — result', () => {
    test('success result sets thread to completed', async () => {
      tmMock.threads.set('t1', { sessionId: null });
      await runner.startAgent('t1', 'test', '/tmp');
      wsMock.events.length = 0;

      const msg: CLIResultMessage = {
        type: 'result',
        subtype: 'success',
        is_error: false,
        duration_ms: 10000,
        num_turns: 5,
        result: 'Done!',
        total_cost_usd: 0.05,
        session_id: 'sess-1',
      };

      lastProcess.simulateMessage(msg);

      expect(tmMock.threads.get('t1')?.status).toBe('completed');
      expect(tmMock.threads.get('t1')?.cost).toBe(0.05);

      const resultEvent = wsMock.events.find(e => e.type === 'agent:result');
      expect(resultEvent!.data).toMatchObject({
        result: 'Done!',
        cost: 0.05,
        duration: 10000,
        status: 'completed',
      });
    });

    test('error result sets thread to failed', async () => {
      tmMock.threads.set('t1', { sessionId: null });
      await runner.startAgent('t1', 'test', '/tmp');

      const msg: CLIResultMessage = {
        type: 'result',
        subtype: 'error_max_turns',
        is_error: true,
        duration_ms: 60000,
        num_turns: 30,
        total_cost_usd: 1.5,
        session_id: 'sess-1',
      };

      lastProcess.simulateMessage(msg);

      expect(tmMock.threads.get('t1')?.status).toBe('failed');
    });

    test('deduplicates result messages', async () => {
      tmMock.threads.set('t1', { sessionId: null });
      await runner.startAgent('t1', 'test', '/tmp');
      wsMock.events.length = 0;

      const msg: CLIResultMessage = {
        type: 'result',
        subtype: 'success',
        is_error: false,
        duration_ms: 5000,
        num_turns: 2,
        total_cost_usd: 0.01,
        session_id: 'sess-1',
      };

      lastProcess.simulateMessage(msg);
      lastProcess.simulateMessage(msg);

      const resultEvents = wsMock.events.filter(e => e.type === 'agent:result');
      expect(resultEvents).toHaveLength(1);
    });

    test('decodes Unicode in result text', async () => {
      tmMock.threads.set('t1', { sessionId: null });
      await runner.startAgent('t1', 'test', '/tmp');
      wsMock.events.length = 0;

      const msg: CLIResultMessage = {
        type: 'result',
        subtype: 'success',
        is_error: false,
        duration_ms: 5000,
        num_turns: 1,
        result: 'caf\\u00e9',
        total_cost_usd: 0.01,
        session_id: 'sess-1',
      };

      lastProcess.simulateMessage(msg);

      const resultEvent = wsMock.events.find(e => e.type === 'agent:result');
      expect(resultEvent!.data).toMatchObject({ result: 'café' });
    });
  });

  // ── stopAgent ───────────────────────────────────────────────

  describe('stopAgent', () => {
    test('kills active process and sets status to stopped', async () => {
      tmMock.threads.set('t1', { sessionId: null });
      await runner.startAgent('t1', 'test', '/tmp');

      await runner.stopAgent('t1');

      expect(tmMock.threads.get('t1')?.status).toBe('stopped');
      expect(runner.isAgentRunning('t1')).toBe(false);

      const stopEvents = wsMock.events.filter(e => e.type === 'agent:status' && (e.data as any).status === 'stopped');
      expect(stopEvents).toHaveLength(1);
    });

    test('sets stopped status even when no active process', async () => {
      await runner.stopAgent('t1');

      expect(tmMock.threads.get('t1')?.status).toBe('stopped');
    });

    test('manually stopped thread does not get failed status on exit', async () => {
      tmMock.threads.set('t1', { sessionId: null });
      await runner.startAgent('t1', 'test', '/tmp');
      const proc = lastProcess;

      await runner.stopAgent('t1');

      // Simulate the exit that happens after kill
      proc.simulateExit(null);

      // Status should remain stopped, not failed
      expect(tmMock.threads.get('t1')?.status).toBe('stopped');
    });
  });

  // ── isAgentRunning ──────────────────────────────────────────

  describe('isAgentRunning', () => {
    test('returns false for unknown thread', () => {
      expect(runner.isAgentRunning('nonexistent')).toBe(false);
    });

    test('returns true for running thread', async () => {
      tmMock.threads.set('t1', { sessionId: null });
      await runner.startAgent('t1', 'test', '/tmp');

      expect(runner.isAgentRunning('t1')).toBe(true);
    });
  });

  // ── cleanupThreadState ──────────────────────────────────────

  describe('cleanupThreadState', () => {
    test('clears all in-memory state for a thread', async () => {
      tmMock.threads.set('t1', { sessionId: null });
      await runner.startAgent('t1', 'test', '/tmp');

      // Simulate some messages to populate state
      const assistantMsg: CLIAssistantMessage = {
        type: 'assistant',
        message: {
          id: 'cli-1',
          content: [
            { type: 'text', text: 'Hello' },
            { type: 'tool_use', id: 'tu-1', name: 'Read', input: { file: 'a.ts' } },
          ],
        },
      };
      lastProcess.simulateMessage(assistantMsg);

      expect(runner.isAgentRunning('t1')).toBe(true);

      runner.cleanupThreadState('t1');

      expect(runner.isAgentRunning('t1')).toBe(false);
    });

    test('is safe to call on unknown thread', () => {
      // Should not throw
      runner.cleanupThreadState('nonexistent');
    });
  });

  // ── Process exit handling ───────────────────────────────────

  describe('process exit handling', () => {
    test('exit without result marks thread as failed', async () => {
      tmMock.threads.set('t1', { sessionId: null });
      await runner.startAgent('t1', 'test', '/tmp');

      lastProcess.simulateExit(1);

      expect(tmMock.threads.get('t1')?.status).toBe('failed');
      const errorEvents = wsMock.events.filter(e => e.type === 'agent:error');
      expect(errorEvents.length).toBeGreaterThan(0);
    });

    test('exit after result does not overwrite completed status', async () => {
      tmMock.threads.set('t1', { sessionId: null });
      await runner.startAgent('t1', 'test', '/tmp');

      // Simulate result first
      lastProcess.simulateMessage({
        type: 'result',
        subtype: 'success',
        is_error: false,
        duration_ms: 5000,
        num_turns: 1,
        total_cost_usd: 0.01,
        session_id: 'sess-1',
      });

      // Then exit
      lastProcess.simulateExit(0);

      expect(tmMock.threads.get('t1')?.status).toBe('completed');
    });

    test('error event marks thread as failed when no result received', async () => {
      tmMock.threads.set('t1', { sessionId: null });
      await runner.startAgent('t1', 'test', '/tmp');

      lastProcess.simulateError(new Error('process crashed'));

      expect(tmMock.threads.get('t1')?.status).toBe('failed');
    });

    test('error event does not overwrite status after manual stop', async () => {
      tmMock.threads.set('t1', { sessionId: null });
      await runner.startAgent('t1', 'test', '/tmp');
      const proc = lastProcess;

      // Mark as manually stopped
      await runner.stopAgent('t1');

      // Now simulate an error from the dying process
      proc.simulateError(new Error('killed'));

      // Status should remain 'stopped', not 'failed'
      expect(tmMock.threads.get('t1')?.status).toBe('stopped');
    });
  });

  // ── Session resume: processedToolUseIds preserved ───────────

  describe('session resume deduplication', () => {
    test('processedToolUseIds survive across startAgent calls', async () => {
      tmMock.threads.set('t1', { sessionId: 'sess-1' });

      // First session
      await runner.startAgent('t1', 'first prompt', '/tmp');
      const proc1 = lastProcess;

      // Process a tool call
      proc1.simulateMessage({
        type: 'assistant',
        message: {
          id: 'cli-1',
          content: [
            { type: 'tool_use', id: 'tu-1', name: 'Read', input: { file: 'a.ts' } },
          ],
        },
      });

      const tcCountAfterFirst = tmMock.toolCalls.size;

      // Simulate result and exit
      proc1.simulateMessage({
        type: 'result',
        subtype: 'success',
        is_error: false,
        duration_ms: 5000,
        num_turns: 1,
        total_cost_usd: 0.01,
        session_id: 'sess-1',
      });
      proc1.simulateExit(0);

      // Second session (resume) — same tool call re-sent by CLI
      await runner.startAgent('t1', 'follow up', '/tmp');
      const proc2 = lastProcess;

      proc2.simulateMessage({
        type: 'assistant',
        message: {
          id: 'cli-1',
          content: [
            { type: 'tool_use', id: 'tu-1', name: 'Read', input: { file: 'a.ts' } },
          ],
        },
      });

      // Should not create a duplicate tool call
      expect(tmMock.toolCalls.size).toBe(tcCountAfterFirst);
    });
  });

  // ── Full lifecycle ──────────────────────────────────────────

  describe('full lifecycle', () => {
    test('start → text → tool → tool_result → result → exit', async () => {
      tmMock.threads.set('t1', { sessionId: null });
      await runner.startAgent('t1', 'Fix the bug', '/tmp');

      // Init
      lastProcess.simulateMessage({
        type: 'system',
        subtype: 'init',
        session_id: 'sess-new',
        tools: ['Read'],
        cwd: '/tmp',
      });

      // Assistant text + tool_use
      lastProcess.simulateMessage({
        type: 'assistant',
        message: {
          id: 'cli-1',
          content: [
            { type: 'text', text: 'Let me read the file' },
            { type: 'tool_use', id: 'tu-1', name: 'Read', input: { file: 'bug.ts' } },
          ],
        },
      });

      // Tool result
      lastProcess.simulateMessage({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tu-1', content: 'file contents...' },
          ],
        },
      });

      // Final assistant text
      lastProcess.simulateMessage({
        type: 'assistant',
        message: {
          id: 'cli-2',
          content: [{ type: 'text', text: 'I found and fixed the bug' }],
        },
      });

      // Result
      lastProcess.simulateMessage({
        type: 'result',
        subtype: 'success',
        is_error: false,
        duration_ms: 15000,
        num_turns: 3,
        result: 'Bug fixed',
        total_cost_usd: 0.08,
        session_id: 'sess-new',
      });

      lastProcess.simulateExit(0);

      // Verify final state
      expect(tmMock.threads.get('t1')?.status).toBe('completed');
      expect(tmMock.threads.get('t1')?.sessionId).toBe('sess-new');
      expect(tmMock.threads.get('t1')?.cost).toBe(0.08);

      // Messages: user + assistant (text+tool) + assistant (final text) = 3
      // user message from startAgent + 2 assistant messages
      const msgs = [...tmMock.messages.values()];
      expect(msgs.filter(m => m.role === 'user')).toHaveLength(1);
      expect(msgs.filter(m => m.role === 'assistant')).toHaveLength(2);

      // Tool calls: 1
      expect(tmMock.toolCalls.size).toBe(1);
      const tc = [...tmMock.toolCalls.values()][0];
      expect(tc.name).toBe('Read');
      expect(tc.output).toBe('file contents...');

      // WS events should include: status(running), init, message, tool_call, tool_output, message, result
      expect(wsMock.events.length).toBeGreaterThanOrEqual(6);
    });
  });
});
