import { describe, expect, test, vi } from 'vitest';

import { type ConnectionSocket, watchSocketConnection } from './watch-socket-connection';

class FakeSocket implements ConnectionSocket {
  connected = false;
  private listeners = new Map<string, Set<() => void>>();
  on(event: string, listener: () => void) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(listener);
  }
  off(event: string, listener: () => void) {
    this.listeners.get(event)?.delete(listener);
  }
  fire(event: 'connect' | 'disconnect') {
    this.connected = event === 'connect';
    for (const listener of this.listeners.get(event) ?? []) listener();
  }
  listenerCount() {
    let count = 0;
    for (const set of this.listeners.values()) count += set.size;
    return count;
  }
}

function activeSocketRegistry(initial: FakeSocket | null) {
  let active = initial;
  const listeners = new Set<(socket: FakeSocket | null) => void>();
  return {
    getActive: () => active,
    subscribe: (listener: (socket: FakeSocket | null) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    replace: (socket: FakeSocket | null) => {
      active = socket;
      for (const listener of listeners) listener(socket);
    },
  };
}

describe('watchSocketConnection', () => {
  test('follows a socket that replaces the one seen at mount', () => {
    const first = new FakeSocket();
    first.connected = true;
    const registry = activeSocketRegistry(first);
    const onChange = vi.fn();

    watchSocketConnection(registry.getActive, registry.subscribe, onChange);
    expect(onChange).toHaveBeenLastCalledWith(true);

    // Hot update: the old socket is torn down and a new one is created.
    first.fire('disconnect');
    registry.replace(null);
    const second = new FakeSocket();
    registry.replace(second);
    expect(onChange).toHaveBeenLastCalledWith(false);

    second.fire('connect');
    expect(onChange).toHaveBeenLastCalledWith(true);
    expect(first.listenerCount()).toBe(0);
  });

  test('binds once a socket appears when none was active at mount', () => {
    const registry = activeSocketRegistry(null);
    const onChange = vi.fn();

    watchSocketConnection(registry.getActive, registry.subscribe, onChange);
    const socket = new FakeSocket();
    registry.replace(socket);
    socket.fire('connect');

    expect(onChange).toHaveBeenLastCalledWith(true);
  });

  test('stops listening after unsubscribe', () => {
    const socket = new FakeSocket();
    const registry = activeSocketRegistry(socket);
    const onChange = vi.fn();

    const stop = watchSocketConnection(registry.getActive, registry.subscribe, onChange);
    stop();
    onChange.mockClear();
    socket.fire('connect');
    registry.replace(new FakeSocket());

    expect(onChange).not.toHaveBeenCalled();
    expect(socket.listenerCount()).toBe(0);
  });
});
