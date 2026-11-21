import { vi } from 'bun:test';

import type { Message, ThreadEvent, ToolCall } from '@funny/shared';
import { io, type Socket } from 'socket.io-client';

/**
 * Typed builders for the hook and store tests: complete fixtures with a
 * plausible default for every required field, so a test names only what it
 * is about and needs no cast. Overrides win.
 */

/** A loaded message, as it sits in a thread payload's `messages`. */
export type BuiltMessage = Message & { toolCalls?: ToolCall[] };

/** A message on thread `t1`; assistant by default. */
export function buildMessage(overrides: Partial<BuiltMessage> = {}): BuiltMessage {
  return {
    id: 'm1',
    threadId: 't1',
    role: 'assistant',
    content: '',
    timestamp: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** A tool call on message `m1`, with an empty JSON input. */
export function buildToolCall(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: 'tc1',
    messageId: 'm1',
    name: 'Read',
    input: '{}',
    ...overrides,
  };
}

/** A Socket.IO frame as the server sends it: `{ threadId, data }`. */
export interface SocketFrame {
  threadId?: string;
  data?: object;
}

type FrameHandler = (frame: SocketFrame) => void;

export interface RecordingSocket {
  /** A real, never-connected Socket.IO client socket. */
  socket: Socket;
  /** The last handler registered per event, to drive events by hand. */
  handlers: Record<string, FrameHandler>;
  onCalls: Array<{ event: string; handler: FrameHandler }>;
  offCalls: Array<{ event: string; handler: FrameHandler }>;
}

/**
 * A real Socket.IO client socket that never connects (`autoConnect: false`)
 * and records the listeners attached to it, so tests can hand it to
 * `registerSocketIOHandlers` and fire events by name without a fake `Socket`.
 */
export function buildRecordingSocket(): RecordingSocket {
  const socket = io('http://localhost', { autoConnect: false, forceNew: true });
  const handlers: Record<string, FrameHandler> = {};
  const onCalls: RecordingSocket['onCalls'] = [];
  const offCalls: RecordingSocket['offCalls'] = [];
  // socket.io types `on` / `off` per reserved event; the recorder takes any frame.
  const on = (event: string, handler: FrameHandler) => {
    handlers[event] = handler;
    onCalls.push({ event, handler });
    return socket;
  };
  const off = (event?: string, handler?: FrameHandler) => {
    if (event && handler) offCalls.push({ event, handler });
    return socket;
  };
  Reflect.set(socket, 'on', vi.fn(on));
  Reflect.set(socket, 'off', vi.fn(off));
  return { socket, handlers, onCalls, offCalls };
}

/** A persisted thread event on thread `t1`. */
export function buildThreadEvent(overrides: Partial<ThreadEvent> = {}): ThreadEvent {
  return {
    id: 'ev-1',
    threadId: 't1',
    type: 'git:commit',
    data: '{}',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}
