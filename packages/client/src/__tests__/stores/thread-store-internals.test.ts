import { describe, test, expect, beforeEach } from 'vitest';

import {
  getSelectGeneration,
  nextSelectGeneration,
  invalidateSelectThread,
  getBufferedInitInfo,
  setBufferedInitInfo,
  bufferWSEvent,
  getAndClearWSBuffer,
  clearWSBuffer,
  setAppNavigate,
  getNavigate,
} from '@/stores/thread-store-internals';

describe('select generation counter', () => {
  test('nextSelectGeneration increments and returns new value', () => {
    const gen1 = nextSelectGeneration();
    const gen2 = nextSelectGeneration();
    expect(gen2).toBe(gen1 + 1);
  });

  test('getSelectGeneration returns current value', () => {
    const gen = nextSelectGeneration();
    expect(getSelectGeneration()).toBe(gen);
  });

  test('invalidateSelectThread increments generation', () => {
    const before = getSelectGeneration();
    invalidateSelectThread();
    expect(getSelectGeneration()).toBe(before + 1);
  });
});

describe('init info buffer', () => {
  beforeEach(() => {
    // Clear any leftover buffer
    getBufferedInitInfo('cleanup-thread');
  });

  test('setBufferedInitInfo stores and getBufferedInitInfo retrieves', () => {
    const info = { tools: ['Read', 'Write'], cwd: '/tmp', model: 'sonnet' };
    setBufferedInitInfo('t1', info);
    expect(getBufferedInitInfo('t1')).toEqual(info);
  });

  test('getBufferedInitInfo returns undefined for non-existent thread', () => {
    expect(getBufferedInitInfo('nonexistent')).toBeUndefined();
  });

  test('getBufferedInitInfo clears the buffer after retrieval', () => {
    const info = { tools: [], cwd: '/tmp', model: 'opus' };
    setBufferedInitInfo('t2', info);
    getBufferedInitInfo('t2');
    expect(getBufferedInitInfo('t2')).toBeUndefined();
  });
});

describe('WS event buffer', () => {
  beforeEach(() => {
    clearWSBuffer('t1');
    clearWSBuffer('t2');
  });

  test('bufferWSEvent stores events and getAndClearWSBuffer retrieves', () => {
    bufferWSEvent('t1', 'message', { content: 'hello' });
    bufferWSEvent('t1', 'tool_call', { name: 'Read' });
    const events = getAndClearWSBuffer('t1');
    expect(events).toHaveLength(2);
    expect(events![0]).toEqual({ type: 'message', data: { content: 'hello' } });
    expect(events![1]).toEqual({ type: 'tool_call', data: { name: 'Read' } });
  });

  test('getAndClearWSBuffer returns undefined for empty buffer', () => {
    expect(getAndClearWSBuffer('nonexistent')).toBeUndefined();
  });

  test('getAndClearWSBuffer clears the buffer after retrieval', () => {
    bufferWSEvent('t1', 'message', { content: 'test' });
    getAndClearWSBuffer('t1');
    expect(getAndClearWSBuffer('t1')).toBeUndefined();
  });

  test('clearWSBuffer clears events for a thread', () => {
    bufferWSEvent('t1', 'message', { content: 'test' });
    clearWSBuffer('t1');
    expect(getAndClearWSBuffer('t1')).toBeUndefined();
  });

  test('events are isolated per thread', () => {
    bufferWSEvent('t1', 'message', { content: 'from t1' });
    bufferWSEvent('t2', 'message', { content: 'from t2' });
    const t1Events = getAndClearWSBuffer('t1');
    const t2Events = getAndClearWSBuffer('t2');
    expect(t1Events![0].data.content).toBe('from t1');
    expect(t2Events![0].data.content).toBe('from t2');
  });
});

describe('navigation ref', () => {
  beforeEach(() => {
    setAppNavigate(null as any);
  });

  test('setAppNavigate and getNavigate work together', () => {
    const mockNavigate = (_path: string) => {};
    setAppNavigate(mockNavigate);
    expect(getNavigate()).toBe(mockNavigate);
  });

  test('getNavigate returns null when not set', () => {
    expect(getNavigate()).toBeNull();
  });
});
