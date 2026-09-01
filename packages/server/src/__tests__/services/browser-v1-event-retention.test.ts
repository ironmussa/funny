import { describe, expect, test } from 'bun:test';

import { create } from '@bufbuild/protobuf';
import {
  CursorSchema,
  DeliveryClass,
  ScopeKind,
  ScopeReferenceSchema,
} from '@funny/shared/browser-v1/common';
import { ApplicationEventSchema } from '@funny/shared/browser-v1/events';

import { BrowserV1EventRetention } from '../../services/socketio/browser-v1-event-retention.js';

const scope = create(ScopeReferenceSchema, { kind: ScopeKind.THREAD_STREAM, id: 'thread-1' });

function event(deliveryClass: DeliveryClass) {
  return create(ApplicationEventSchema, {
    delivery: { deliveryClass },
    payload: {
      case: 'threadStream',
      value: { threadId: 'thread-1', eventType: 'message:created' },
    },
  });
}

function cursor(sequence: bigint) {
  return create(CursorSchema, { scope, lastSequence: sequence, lastRevision: sequence });
}

describe('browser.v1 event retention', () => {
  test('assigns stable IDs, scoped sequences, revisions, and replays retained durable events', () => {
    let id = 0;
    const store = new BrowserV1EventRetention({
      maxAgeMs: 60_000,
      maxBytesPerScope: 100_000,
      eventId: () => `event-${++id}`,
      now: () => 1_000,
    });
    const first = store.append(scope, event(DeliveryClass.DURABLE));
    const second = store.append(scope, event(DeliveryClass.DURABLE));
    const third = store.append(scope, event(DeliveryClass.DURABLE));

    expect(first.metadata).toMatchObject({ eventId: 'event-1', sequence: 1n, revision: 1n });
    expect(second.metadata).toMatchObject({ eventId: 'event-2', sequence: 2n, revision: 2n });
    expect(store.resume(scope, cursor(1n))).toMatchObject({
      kind: 'accepted',
      events: [second, third],
      cursor: { lastSequence: 3n, lastRevision: 3n },
    });
  });

  test('reports an explicit gap when byte retention evicts requested history', () => {
    const store = new BrowserV1EventRetention({
      maxAgeMs: 60_000,
      maxBytesPerScope: 1,
      eventId: () => crypto.randomUUID(),
      now: () => 1_000,
    });
    store.append(scope, event(DeliveryClass.DURABLE));
    store.append(scope, event(DeliveryClass.DURABLE));
    expect(store.resume(scope, cursor(0n))).toMatchObject({
      kind: 'gap',
      earliestAvailableSequence: 3n,
      cursor: { lastSequence: 2n },
    });
  });

  test('requires a targeted snapshot after non-replayable state changes', () => {
    const store = new BrowserV1EventRetention({
      maxAgeMs: 60_000,
      maxBytesPerScope: 100_000,
      now: () => 1_000,
    });
    store.append(scope, event(DeliveryClass.SNAPSHOT_RECOVERABLE));
    expect(store.resume(scope, cursor(0n))).toMatchObject({
      kind: 'snapshot-required',
      cursor: { scope: { kind: ScopeKind.THREAD_STREAM, id: 'thread-1' } },
    });
  });

  test('expires retained history by age', () => {
    let now = 1_000;
    const store = new BrowserV1EventRetention({
      maxAgeMs: 100,
      maxBytesPerScope: 100_000,
      now: () => now,
    });
    store.append(scope, event(DeliveryClass.DURABLE));
    now += 101;
    expect(store.resume(scope, cursor(0n))).toMatchObject({ kind: 'gap' });
  });
});
