import { describe, expect, test } from 'vitest';

import { GrpcTerminalReplayStore } from '../../services/grpc-terminal-replay-store.js';

describe('GrpcTerminalReplayStore', () => {
  test('replays ordered output after the last seen sequence within retention', () => {
    const store = new GrpcTerminalReplayStore(3, 64, 16);
    store.append('pty-1', Uint8Array.from([1]));
    store.append('pty-1', Uint8Array.from([2]));
    store.append('pty-1', Uint8Array.from([3]));

    expect(store.replay('pty-1', 1n)).toEqual({
      kind: 'replay',
      outputs: [
        { sequence: 2n, data: Uint8Array.from([2]) },
        { sequence: 3n, data: Uint8Array.from([3]) },
      ],
      latestSequence: 3n,
    });
  });

  test('returns an explicit gap when requested output has fallen out of retention', () => {
    const store = new GrpcTerminalReplayStore(2, 64, 16);
    store.append('pty-1', Uint8Array.from([1]));
    store.append('pty-1', Uint8Array.from([2]));
    store.append('pty-1', Uint8Array.from([3]));

    expect(store.replay('pty-1', 0n)).toEqual({
      kind: 'gap',
      earliestAvailableSequence: 2n,
      latestSequence: 3n,
    });
  });

  test('bounds retained output by bytes as well as frame count', () => {
    const store = new GrpcTerminalReplayStore(10, 5, 4);
    store.append('pty-1', Uint8Array.from([1, 2, 3]));
    store.append('pty-1', Uint8Array.from([4, 5, 6]));

    expect(store.replay('pty-1', 0n)).toEqual({
      kind: 'gap',
      earliestAvailableSequence: 2n,
      latestSequence: 2n,
    });
  });

  test('suppresses duplicate input ordinals without retaining input bytes', () => {
    const store = new GrpcTerminalReplayStore(2, 64, 16);

    expect(store.acceptInput('pty-1', 1n)).toBe(true);
    expect(store.acceptInput('pty-1', 1n)).toBe(false);
    expect(store.acceptInput('pty-1', 2n)).toBe(true);
    expect(store.acceptInput('pty-1', 1n)).toBe(false);
    expect(store.replay('pty-1', 0n)).toEqual({
      kind: 'replay',
      outputs: [],
      latestSequence: 0n,
    });
  });

  test('copies output buffers and never stores terminal input', () => {
    const store = new GrpcTerminalReplayStore(2, 64, 16);
    const buffer = Uint8Array.from([1, 2]);
    store.append('pty-1', buffer);
    buffer[0] = 9;

    expect(store.replay('pty-1', 0n)).toEqual({
      kind: 'replay',
      outputs: [{ sequence: 1n, data: Uint8Array.from([1, 2]) }],
      latestSequence: 1n,
    });
    expect(Object.keys(store)).not.toContain('inputs');
  });
});
