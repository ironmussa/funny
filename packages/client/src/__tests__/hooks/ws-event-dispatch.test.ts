import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { clearWSDispatchState } from '@/hooks/ws-event-dispatch';
import { useThreadStore } from '@/stores/thread-store';

// Stub RAF to be manually drained — vitest's jsdom doesn't run animation
// frames unless we drive them, which is exactly what we want for this test:
// we need to simulate the "tab hidden, RAF paused" scenario.
const rafCallbacks: Array<() => void> = [];

beforeEach(() => {
  rafCallbacks.length = 0;
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
    rafCallbacks.push(cb);
    return rafCallbacks.length;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    rafCallbacks[id - 1] = () => {};
  });
});

afterEach(() => {
  clearWSDispatchState();
  vi.unstubAllGlobals();
});

function drainRaf() {
  const pending = rafCallbacks.slice();
  rafCallbacks.length = 0;
  for (const cb of pending) cb();
}

describe('ws-event-dispatch — pendingMessages keying', () => {
  test('multiple distinct messages for the same thread between flushes are all applied (regression: tab-hidden message loss)', async () => {
    const calls: Array<{ threadId: string; data: any }> = [];
    useThreadStore.setState({
      handleWSMessage: ((tid: string, data: any) => {
        calls.push({ threadId: tid, data });
      }) as any,
    });

    // We dispatch events by importing the module-scoped dispatchEvent.
    // It's not exported, but registerSocketIOHandlers is — we reach it via
    // a fake socket.on hook to capture the inner dispatchEvent.
    const { registerSocketIOHandlers } = await import('@/hooks/ws-event-dispatch');
    const handlers: Record<string, (e: any) => void> = {};
    const fakeSocket = {
      on(event: string, handler: (e: any) => void) {
        handlers[event] = handler;
      },
    } as any;
    registerSocketIOHandlers(fakeSocket);

    // Simulate: tab hidden, RAF paused. Two DIFFERENT messages arrive for the
    // same thread. Before the fix, the second overwrote the first in the Map.
    handlers['agent:message']({
      threadId: 't1',
      data: { messageId: 'm1', role: 'assistant', content: 'first' },
    });
    handlers['agent:message']({
      threadId: 't1',
      data: { messageId: 'm2', role: 'assistant', content: 'second' },
    });
    handlers['agent:message']({
      threadId: 't1',
      data: { messageId: 'm3', role: 'assistant', content: 'third' },
    });

    // Now drain RAF (tab regains focus).
    drainRaf();

    // All three messages must reach handleWSMessage. Before the fix, only the
    // last (m3) survived because pendingMessages was keyed by threadId.
    expect(calls.map((c) => c.data.messageId)).toEqual(['m1', 'm2', 'm3']);
  });

  test('streaming chunks of the same message collapse to the latest content', async () => {
    const calls: Array<{ threadId: string; data: any }> = [];
    useThreadStore.setState({
      handleWSMessage: ((tid: string, data: any) => {
        calls.push({ threadId: tid, data });
      }) as any,
    });

    const { registerSocketIOHandlers } = await import('@/hooks/ws-event-dispatch');
    const handlers: Record<string, (e: any) => void> = {};
    const fakeSocket = {
      on(event: string, handler: (e: any) => void) {
        handlers[event] = handler;
      },
    } as any;
    registerSocketIOHandlers(fakeSocket);

    // Server streams the same message with growing content (same messageId).
    handlers['agent:message']({
      threadId: 't1',
      data: { messageId: 'm1', role: 'assistant', content: 'Hel' },
    });
    handlers['agent:message']({
      threadId: 't1',
      data: { messageId: 'm1', role: 'assistant', content: 'Hello' },
    });
    handlers['agent:message']({
      threadId: 't1',
      data: { messageId: 'm1', role: 'assistant', content: 'Hello world' },
    });

    drainRaf();

    // Only one apply, with the latest cumulative content. The keying must
    // dedupe on messageId (not lose streaming chunks).
    expect(calls.length).toBe(1);
    expect(calls[0].data.content).toBe('Hello world');
  });

  test('unregisterSocketIOHandlers detaches all listeners (HMR dispose path)', async () => {
    const { registerSocketIOHandlers, unregisterSocketIOHandlers } =
      await import('@/hooks/ws-event-dispatch');
    const onCalls: Array<{ event: string; handler: any }> = [];
    const offCalls: Array<{ event: string; handler: any }> = [];
    const fakeSocket: any = {
      on(event: string, handler: any) {
        onCalls.push({ event, handler });
      },
      off(event: string, handler: any) {
        offCalls.push({ event, handler });
      },
    };

    registerSocketIOHandlers(fakeSocket);
    expect(onCalls.length).toBeGreaterThan(0);

    unregisterSocketIOHandlers(fakeSocket);
    expect(offCalls.length).toBe(onCalls.length);
    // Every attached handler must have been detached with the SAME reference,
    // otherwise socket.off is a no-op (Socket.IO matches by identity).
    for (let i = 0; i < onCalls.length; i++) {
      expect(offCalls[i].event).toBe(onCalls[i].event);
      expect(offCalls[i].handler).toBe(onCalls[i].handler);
    }
  });

  test('different threads do not interfere with each other', async () => {
    const calls: Array<{ threadId: string; data: any }> = [];
    useThreadStore.setState({
      handleWSMessage: ((tid: string, data: any) => {
        calls.push({ threadId: tid, data });
      }) as any,
    });

    const { registerSocketIOHandlers } = await import('@/hooks/ws-event-dispatch');
    const handlers: Record<string, (e: any) => void> = {};
    const fakeSocket = {
      on(event: string, handler: (e: any) => void) {
        handlers[event] = handler;
      },
    } as any;
    registerSocketIOHandlers(fakeSocket);

    handlers['agent:message']({
      threadId: 't1',
      data: { messageId: 'm1', role: 'assistant', content: 'A' },
    });
    handlers['agent:message']({
      threadId: 't2',
      data: { messageId: 'm2', role: 'assistant', content: 'B' },
    });

    drainRaf();

    expect(calls.length).toBe(2);
    expect(calls.map((c) => `${c.threadId}:${c.data.messageId}`).sort()).toEqual([
      't1:m1',
      't2:m2',
    ]);
  });

  test('agent:status routes to handleWSStatus after RAF flush', async () => {
    const statusCalls: Array<{ threadId: string; data: any }> = [];
    useThreadStore.setState({
      handleWSStatus: ((tid: string, data: any) => {
        statusCalls.push({ threadId: tid, data });
      }) as any,
    });

    const { registerSocketIOHandlers } = await import('@/hooks/ws-event-dispatch');
    const handlers: Record<string, (e: any) => void> = {};
    const fakeSocket = {
      on(event: string, handler: (e: any) => void) {
        handlers[event] = handler;
      },
    } as any;
    registerSocketIOHandlers(fakeSocket);

    handlers['agent:status']({ threadId: 't9', data: { status: 'running' } });
    drainRaf();

    expect(statusCalls).toEqual([{ threadId: 't9', data: { status: 'running' } }]);
  });

  test('agent:result routes to handleWSResult after RAF flush', async () => {
    const resultCalls: Array<{ threadId: string; data: any }> = [];
    useThreadStore.setState({
      handleWSResult: ((tid: string, data: any) => {
        resultCalls.push({ threadId: tid, data });
      }) as any,
    });

    const { registerSocketIOHandlers } = await import('@/hooks/ws-event-dispatch');
    const handlers: Record<string, (e: any) => void> = {};
    const fakeSocket = {
      on(event: string, handler: (e: any) => void) {
        handlers[event] = handler;
      },
    } as any;
    registerSocketIOHandlers(fakeSocket);

    handlers['agent:result']({
      threadId: 't9',
      data: { status: 'completed', cost: 0.2, duration: 5 },
    });
    drainRaf();

    expect(resultCalls).toEqual([
      { threadId: 't9', data: { status: 'completed', cost: 0.2, duration: 5 } },
    ]);
  });

  test('agent:tool_output batches and flushes via RAF', async () => {
    const toolCalls: Array<{ threadId: string; data: any }> = [];
    useThreadStore.setState({
      handleWSToolOutput: ((tid: string, data: any) => {
        toolCalls.push({ threadId: tid, data });
      }) as any,
    });

    const { registerSocketIOHandlers } = await import('@/hooks/ws-event-dispatch');
    const handlers: Record<string, (e: any) => void> = {};
    const fakeSocket = {
      on(event: string, handler: (e: any) => void) {
        handlers[event] = handler;
      },
    } as any;
    registerSocketIOHandlers(fakeSocket);

    handlers['agent:tool_output']({
      threadId: 't1',
      data: { toolCallId: 'tc1', output: 'partial' },
    });
    expect(toolCalls).toHaveLength(0);

    drainRaf();
    expect(toolCalls).toEqual([{ threadId: 't1', data: { toolCallId: 'tc1', output: 'partial' } }]);
  });

  test('agent:init applies immediately without RAF batching', async () => {
    const initCalls: Array<{ threadId: string; data: any }> = [];
    useThreadStore.setState({
      handleWSInit: ((tid: string, data: any) => {
        initCalls.push({ threadId: tid, data });
      }) as any,
    });

    const { registerSocketIOHandlers } = await import('@/hooks/ws-event-dispatch');
    const handlers: Record<string, (e: any) => void> = {};
    const fakeSocket = {
      on(event: string, handler: (e: any) => void) {
        handlers[event] = handler;
      },
    } as any;
    registerSocketIOHandlers(fakeSocket);

    handlers['agent:init']({ threadId: 't5', data: { sessionId: 'sess-1' } });

    expect(initCalls).toEqual([{ threadId: 't5', data: { sessionId: 'sess-1' } }]);
  });

  test('agent:status waiting applies immediately (not batched)', async () => {
    const statusCalls: Array<{ threadId: string; data: any }> = [];
    useThreadStore.setState({
      handleWSStatus: ((tid: string, data: any) => {
        statusCalls.push({ threadId: tid, data });
      }) as any,
    });

    const { registerSocketIOHandlers } = await import('@/hooks/ws-event-dispatch');
    const handlers: Record<string, (e: any) => void> = {};
    const fakeSocket = {
      on(event: string, handler: (e: any) => void) {
        handlers[event] = handler;
      },
    } as any;
    registerSocketIOHandlers(fakeSocket);

    handlers['agent:status']({
      threadId: 't1',
      data: { status: 'waiting', waitingReason: 'permission' },
    });

    expect(statusCalls).toHaveLength(1);
    drainRaf();
    expect(statusCalls).toHaveLength(1);
  });

  test('duplicate agent:status events are deduped per thread', async () => {
    const statusCalls: Array<{ threadId: string; data: any }> = [];
    useThreadStore.setState({
      handleWSStatus: ((tid: string, data: any) => {
        statusCalls.push({ threadId: tid, data });
      }) as any,
    });

    const { registerSocketIOHandlers } = await import('@/hooks/ws-event-dispatch');
    const handlers: Record<string, (e: any) => void> = {};
    const fakeSocket = {
      on(event: string, handler: (e: any) => void) {
        handlers[event] = handler;
      },
    } as any;
    registerSocketIOHandlers(fakeSocket);

    const payload = { threadId: 't1', data: { status: 'running' } };
    handlers['agent:status'](payload);
    handlers['agent:status'](payload);
    drainRaf();

    expect(statusCalls).toHaveLength(1);
  });
});
