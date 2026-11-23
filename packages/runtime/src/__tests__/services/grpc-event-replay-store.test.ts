import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EventDurability } from '@funny/shared/runner-v2/events';

import { GrpcEventReplayStore } from '../../services/grpc-event-replay-store.js';

const databasePaths: string[] = [];

afterEach(() => {
  for (const path of databasePaths.splice(0)) {
    for (const candidate of [path, `${path}-shm`, `${path}-wal`]) {
      if (existsSync(candidate)) rmSync(candidate);
    }
  }
});

function databasePath(): string {
  const path = join(tmpdir(), `funny-grpc-events-${crypto.randomUUID()}.db`);
  databasePaths.push(path);
  return path;
}

describe('GrpcEventReplayStore', () => {
  test('resumes only the executions with events the server has not acknowledged', () => {
    const store = new GrpcEventReplayStore(':memory:');
    const settled = { threadId: 'thread-1', executionId: 'execution-settled' };
    const pending = { threadId: 'thread-1', executionId: 'execution-pending' };
    const unsent = { threadId: 'thread-2', executionId: 'execution-unsent' };
    for (const scope of [settled, pending, pending, unsent]) {
      store.append({ scope, eventType: 'agent:chunk', data: {}, durability: 2 });
    }
    store.acknowledge(settled, 1n);
    store.acknowledge(pending, 1n);

    expect(store.resumeCursors()).toEqual([
      { executionId: 'execution-pending', lastAcceptedSequence: 1n },
      { executionId: 'execution-unsent', lastAcceptedSequence: 0n },
    ]);
    store.close();
  });

  test('discards the stored events of an execution the server refuses', () => {
    const path = databasePath();
    const refused = { threadId: 'thread-deleted', executionId: 'execution-refused' };
    const kept = { threadId: 'thread-1', executionId: 'execution-kept' };
    const store = new GrpcEventReplayStore(path);
    for (const scope of [refused, refused, kept]) {
      store.append({ scope, eventType: 'git:status', data: {}, durability: 1 });
    }

    expect(store.discardPending(refused)).toBe(2);
    expect(store.discardPending({ threadId: 'thread-1', executionId: 'execution-refused' })).toBe(
      0,
    );

    expect(store.pendingScopes().map((scope) => scope.executionId)).toEqual(['execution-kept']);
    expect(store.resumeCursors().map((cursor) => cursor.executionId)).toEqual(['execution-kept']);
    // An event sent later for the same execution reports the gap instead of reusing a sequence.
    expect(
      store.append({ scope: refused, eventType: 'git:status', data: {}, durability: 1 }).sequence,
    ).toBe(3n);
    expect(store.replay(refused, 0n)).toMatchObject({
      historyAvailable: false,
      earliestAvailableSequence: 3n,
    });
    store.discardPending(refused);
    store.close();

    // With nothing left to send, the next process drops the execution.
    const restarted = new GrpcEventReplayStore(path);
    expect(restarted.dropSettledScopes()).toBe(1);
    expect(restarted.pendingScopes().map((scope) => scope.executionId)).toEqual(['execution-kept']);
    restarted.close();
  });

  test('drops the acknowledged executions of an earlier process and keeps the pending ones', () => {
    const path = databasePath();
    const settled = { threadId: 'thread-1', executionId: 'execution-settled' };
    const finished = { threadId: 'thread-1', executionId: 'execution-finished' };
    const pending = { threadId: 'thread-2', executionId: 'execution-pending' };
    const first = new GrpcEventReplayStore(path);
    first.append({ scope: settled, eventType: 'agent:chunk', data: {}, durability: 2 });
    first.append({
      scope: finished,
      eventType: 'agent:result',
      data: {},
      durability: EventDurability.TERMINAL,
    });
    first.append({ scope: pending, eventType: 'agent:chunk', data: { index: 1 }, durability: 2 });
    first.append({ scope: pending, eventType: 'agent:chunk', data: { index: 2 }, durability: 2 });
    first.acknowledge(settled, 1n);
    first.acknowledge(finished, 1n);
    first.acknowledge(pending, 1n);
    first.close();

    const restarted = new GrpcEventReplayStore(path);
    expect(restarted.dropSettledScopes()).toBe(2);
    expect(restarted.dropSettledScopes()).toBe(0);

    expect(restarted.resumeCursors()).toEqual([
      { executionId: 'execution-pending', lastAcceptedSequence: 1n },
    ]);
    expect(restarted.replay(pending, 1n).events.map((event) => event.sequence)).toEqual([2n]);
    expect(restarted.pendingScopes().map((scope) => scope.executionId)).toEqual([
      'execution-pending',
    ]);
    // The pending execution keeps its sequence, so the server sees no gap.
    expect(
      restarted.append({ scope: pending, eventType: 'agent:chunk', data: {}, durability: 2 })
        .sequence,
    ).toBe(3n);
    restarted.close();
  });

  test('allocates monotonic sequences per execution and resumes after restart', () => {
    const path = databasePath();
    const scope = { threadId: 'thread-1', executionId: 'execution-1' };
    const first = new GrpcEventReplayStore(path);

    expect(
      first.append({ scope, eventType: 'agent:chunk', data: { text: 'one' }, durability: 2 })
        .sequence,
    ).toBe(1n);
    expect(
      first.append({ scope, eventType: 'agent:chunk', data: { text: 'two' }, durability: 2 })
        .sequence,
    ).toBe(2n);
    expect(
      first.append({
        scope: { threadId: 'thread-2', executionId: 'execution-2' },
        eventType: 'agent:status',
        data: { status: 'running' },
        durability: 2,
      }).sequence,
    ).toBe(1n);
    first.close();

    const restarted = new GrpcEventReplayStore(path);
    expect(
      restarted.append({
        scope,
        eventType: 'agent:result',
        data: { status: 'completed' },
        durability: 3,
      }).sequence,
    ).toBe(3n);
    expect(restarted.replay(scope, 0n).events.map((event) => event.sequence)).toEqual([1n, 2n, 3n]);
    restarted.close();
  });

  test('applies cumulative receipts and keeps them across restart', () => {
    const path = databasePath();
    const scope = { threadId: 'thread-1', executionId: 'execution-1' };
    const first = new GrpcEventReplayStore(path);
    for (let index = 0; index < 3; index += 1) {
      first.append({ scope, eventType: 'agent:chunk', data: { index }, durability: 2 });
    }

    expect(first.acknowledge(scope, 2n)).toBe(true);
    expect(first.acknowledge(scope, 2n)).toBe(false);
    expect(first.replay(scope, 0n).events.map((event) => event.sequence)).toEqual([3n]);
    first.close();

    const restarted = new GrpcEventReplayStore(path);
    expect(restarted.resumeCursors()).toEqual([
      { executionId: 'execution-1', lastAcceptedSequence: 2n },
    ]);
    expect(restarted.replay(scope, 2n).events.map((event) => event.sequence)).toEqual([3n]);
    restarted.close();
  });

  test('bounds retained history and reports when a requested cursor was trimmed', () => {
    const store = new GrpcEventReplayStore(':memory:', { maxEventsPerScope: 2 });
    const scope = { threadId: 'thread-1', executionId: 'execution-1' };
    for (let index = 0; index < 4; index += 1) {
      store.append({ scope, eventType: 'agent:chunk', data: { index }, durability: 1 });
    }

    expect(store.replay(scope, 0n)).toMatchObject({
      earliestAvailableSequence: 3n,
      latestSequence: 4n,
      historyAvailable: false,
    });
    expect(store.replay(scope, 2n).events.map((event) => event.sequence)).toEqual([3n, 4n]);
    store.close();
  });

  test('rejects receipts beyond the allocated sequence and execution reuse across threads', () => {
    const store = new GrpcEventReplayStore(':memory:');
    const scope = { threadId: 'thread-1', executionId: 'execution-1' };
    store.append({ scope, eventType: 'agent:chunk', data: {}, durability: 2 });

    expect(() => store.acknowledge(scope, 2n)).toThrow('receipt exceeds');
    expect(() =>
      store.append({
        scope: { threadId: 'thread-2', executionId: 'execution-1' },
        eventType: 'agent:chunk',
        data: {},
        durability: 2,
      }),
    ).toThrow('another thread');
    store.close();
  });

  test('reserves replay capacity for terminal state during a chunk storm', () => {
    const store = new GrpcEventReplayStore(':memory:', {
      maxEventsPerScope: 3,
      maxBytesPerScope: 1_024,
      terminalReserveEvents: 1,
      terminalReserveBytes: 512,
    });
    const scope = { threadId: 'thread-1', executionId: 'execution-1' };
    for (let index = 0; index < 100; index += 1) {
      store.append({
        scope,
        eventType: 'agent:chunk',
        data: { text: `chunk-${index}` },
        durability: EventDurability.TRANSIENT,
      });
    }
    const terminal = store.append({
      scope,
      eventType: 'agent:result',
      data: { status: 'completed' },
      durability: EventDurability.TERMINAL,
    });

    const replay = store.replay(scope, 0n);
    expect(replay.historyAvailable).toBe(false);
    expect(replay.earliestAvailableSequence).toBe(98n);
    expect(replay.events.map(({ sequence }) => sequence)).toEqual([98n, 99n, 100n, 101n]);
    expect(replay.events.at(-1)).toMatchObject({
      sequence: terminal.sequence,
      eventType: 'agent:result',
      durability: EventDurability.TERMINAL,
    });
    expect(() =>
      store.append({
        scope,
        eventType: 'agent:error',
        data: { message: 'late failure' },
        durability: EventDurability.TERMINAL,
      }),
    ).toThrow('already has a terminal event');
    store.close();
  });

  test('reserves byte capacity for terminal errors after oversized chunk pressure', () => {
    const store = new GrpcEventReplayStore(':memory:', {
      maxEventsPerScope: 100,
      maxBytesPerScope: 160,
      terminalReserveEvents: 1,
      terminalReserveBytes: 256,
    });
    const scope = { threadId: 'thread-1', executionId: 'execution-1' };
    for (let index = 0; index < 20; index += 1) {
      store.append({
        scope,
        eventType: 'agent:chunk',
        data: { text: `${index}-${'x'.repeat(64)}` },
        durability: EventDurability.TRANSIENT,
      });
    }

    const terminal = store.append({
      scope,
      eventType: 'agent:error',
      data: { message: 'provider disconnected' },
      durability: EventDurability.TERMINAL,
    });
    const replay = store.replay(scope, 0n);

    expect(replay.historyAvailable).toBe(false);
    expect(replay.events.at(-1)).toMatchObject({
      sequence: terminal.sequence,
      eventType: 'agent:error',
      durability: EventDurability.TERMINAL,
    });
    store.close();
  });

  test('rejects terminal event types whose durability would bypass reserved capacity', () => {
    const store = new GrpcEventReplayStore(':memory:');
    const scope = { threadId: 'thread-1', executionId: 'execution-1' };

    expect(() =>
      store.append({
        scope,
        eventType: 'agent:result',
        data: { status: 'completed' },
        durability: EventDurability.TRANSIENT,
      }),
    ).toThrow('must use terminal durability');
    expect(() =>
      store.append({
        scope,
        eventType: 'agent:chunk',
        data: { text: 'not terminal' },
        durability: EventDurability.TERMINAL,
      }),
    ).toThrow('must use terminal durability');
    store.close();
  });

  test('prioritizes terminal scopes while a slow consumer drains bounded pages', () => {
    const store = new GrpcEventReplayStore(':memory:', { maxEventsPerScope: 20 });
    const chunkScope = { threadId: 'thread-1', executionId: 'execution-chunks' };
    const terminalScope = { threadId: 'thread-2', executionId: 'execution-terminal' };
    for (let index = 0; index < 5; index += 1) {
      store.append({
        scope: chunkScope,
        eventType: 'agent:chunk',
        data: { index },
        durability: EventDurability.TRANSIENT,
      });
    }
    store.append({
      scope: terminalScope,
      eventType: 'agent:result',
      data: { status: 'completed' },
      durability: EventDurability.TERMINAL,
    });

    expect(store.pendingScopes()).toEqual([
      { ...terminalScope, hasTerminalEvent: true, earliestSequence: 1n },
      { ...chunkScope, hasTerminalEvent: false, earliestSequence: 1n },
    ]);
    expect(store.replay(chunkScope, 0n, 2).events.map(({ sequence }) => sequence)).toEqual([
      1n,
      2n,
    ]);
    expect(store.replay(chunkScope, 0n, 2).events.map(({ sequence }) => sequence)).toEqual([
      1n,
      2n,
    ]);
    expect(store.acknowledge(terminalScope, 1n)).toBe(true);
    expect(store.pendingScopes()).toEqual([
      { ...chunkScope, hasTerminalEvent: false, earliestSequence: 1n },
    ]);
    store.close();
  });

  test('keeps the terminal boundary after acknowledgement and restart', () => {
    const path = databasePath();
    const scope = { threadId: 'thread-1', executionId: 'execution-1' };
    const first = new GrpcEventReplayStore(path);
    const terminal = first.append({
      scope,
      eventType: 'agent:result',
      data: { status: 'completed' },
      durability: EventDurability.TERMINAL,
    });
    expect(first.acknowledge(scope, terminal.sequence)).toBe(true);
    first.close();

    const restarted = new GrpcEventReplayStore(path);
    expect(() =>
      restarted.append({
        scope,
        eventType: 'agent:chunk',
        data: { text: 'late chunk' },
        durability: EventDurability.TRANSIENT,
      }),
    ).toThrow('already has a terminal event');
    restarted.close();
  });
});
