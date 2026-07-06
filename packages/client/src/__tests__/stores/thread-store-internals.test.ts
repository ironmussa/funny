import { describe, test, expect, beforeEach } from 'vitest';

import {
  ThreadStoreInternals,
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

  test('setBufferedInitInfo caps buffered thread count and evicts oldest info', () => {
    const internals = new ThreadStoreInternals();

    for (let i = 0; i < 101; i++) {
      internals.setBufferedInitInfo(`thread-${i}`, {
        tools: [],
        cwd: `/tmp/${i}`,
        model: 'sonnet',
      });
    }

    expect(internals.getBufferedInitInfo('thread-0')).toBeUndefined();
    expect(internals.getBufferedInitInfo('thread-100')?.cwd).toBe('/tmp/100');
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

  test('bufferWSEvent caps events per thread and keeps newest events', () => {
    const internals = new ThreadStoreInternals();

    for (let i = 0; i < 205; i++) {
      internals.bufferWSEvent('busy-thread', 'message', { index: i });
    }

    const events = internals.getAndClearWSBuffer('busy-thread');
    expect(events).toHaveLength(200);
    expect(events![0].data.index).toBe(5);
    expect(events!.at(-1)!.data.index).toBe(204);
  });

  test('bufferWSEvent caps buffered thread count and evicts oldest thread', () => {
    const internals = new ThreadStoreInternals();

    for (let i = 0; i < 101; i++) {
      internals.bufferWSEvent(`thread-${i}`, 'message', { index: i });
    }

    expect(internals.getAndClearWSBuffer('thread-0')).toBeUndefined();
    expect(internals.getAndClearWSBuffer('thread-100')![0].data.index).toBe(100);
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
