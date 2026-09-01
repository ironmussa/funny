import { mock } from 'bun:test';

let canView = true;
mock.module('../../services/thread-access-check.js', () => ({
  canUserViewThread: async () => canView,
  isThreadOwnedBy: async () => true,
  getUserDisplay: async (userId: string) => ({ id: userId, name: userId, image: null }),
}));

import { beforeEach, describe, expect, test } from 'bun:test';

import { create, fromBinary } from '@bufbuild/protobuf';
import {
  BROWSER_V1_CARRIER_EVENTS,
  BROWSER_V1_SCHEMA_FINGERPRINT,
  encodeBrowserCarrier,
} from '@funny/shared/browser-protocol';
import {
  type ScopeReference,
  CursorSchema,
  DeliveryClass,
  Representation,
  ScopeKind,
  ScopeReferenceSchema,
  StatusCode,
} from '@funny/shared/browser-v1/common';
import { ApplicationEventSchema, SubscriptionRequestSchema } from '@funny/shared/browser-v1/events';
import { CarrierEnvelopeSchema } from '@funny/shared/browser-v1/transport';

import { BrowserV1EventRetention } from '../../services/socketio/browser-v1-event-retention.js';
import { setupBrowserV1Events } from '../../services/socketio/browser-v1-events.js';
import { __resetPresenceForTests } from '../../services/socketio/thread-presence.js';
import { createMockSocket } from '../helpers/socketio-test-mocks.js';

function requestWire(scope: ScopeReference, sequence?: bigint) {
  return encodeBrowserCarrier(
    create(CarrierEnvelopeSchema, {
      generatedSchemaFingerprint: BROWSER_V1_SCHEMA_FINGERPRINT,
      payload: {
        case: 'event',
        value: {
          payload: {
            case: 'subscribe',
            value: create(SubscriptionRequestSchema, {
              scope,
              cursor:
                sequence === undefined
                  ? undefined
                  : create(CursorSchema, {
                      scope,
                      lastSequence: sequence,
                      lastRevision: sequence,
                    }),
            }),
          },
        },
      },
    }),
  );
}

function decodeEventEnvelope(wire: Uint8Array) {
  const carrier = fromBinary(CarrierEnvelopeSchema, wire);
  if (carrier.payload.case !== 'event') throw new Error('Expected event carrier');
  return carrier.payload.value.payload;
}

function socketFixture(retention: BrowserV1EventRetention) {
  const joined: string[] = [];
  const socket = createMockSocket({
    data: {
      browserV1: {
        principalUserId: 'user-1',
        assignments: { events: Representation.BROWSER_V1 },
      },
    },
    join: (room: string) => joined.push(room),
    leave: () => {},
    to: () => ({ emit: () => {} }),
  } as any);
  setupBrowserV1Events(socket, 'user-1', retention);
  return { socket, joined };
}

function retention(maxBytesPerScope = 100_000) {
  let id = 0;
  return new BrowserV1EventRetention({
    maxAgeMs: 60_000,
    maxBytesPerScope,
    now: () => 1_000,
    eventId: () => `event-${++id}`,
  });
}

function durableEvent() {
  return create(ApplicationEventSchema, {
    delivery: { deliveryClass: DeliveryClass.DURABLE },
    payload: { case: 'user', value: { eventType: 'profile:updated' } },
  });
}

describe('browser.v1 event subscriptions', () => {
  beforeEach(() => {
    canView = true;
    __resetPresenceForTests();
  });

  test('authorizes user scope and replays retained events after its cursor', async () => {
    const store = retention();
    const scope = create(ScopeReferenceSchema, { kind: ScopeKind.USER, id: 'user-1' });
    store.append(scope, durableEvent());
    store.append(scope, durableEvent());
    const fixture = socketFixture(store);
    let response: Uint8Array | undefined;
    await fixture.socket.triggerRpc<Uint8Array>(
      BROWSER_V1_CARRIER_EVENTS.event,
      requestWire(scope, 1n),
      (wire) => {
        response = wire;
      },
    );

    expect(decodeEventEnvelope(response!)).toMatchObject({
      case: 'subscriptionOutcome',
      value: {
        outcome: {
          case: 'accepted',
          value: { acceptedCursor: { lastSequence: 2n, lastRevision: 2n } },
        },
      },
    });
    const replay = fixture.socket.emitted.find(
      ({ event }) => event === BROWSER_V1_CARRIER_EVENTS.event,
    );
    expect(decodeEventEnvelope(replay?.data as Uint8Array)).toMatchObject({
      case: 'event',
      value: { metadata: { eventId: 'event-2', sequence: 2n } },
    });
  });

  test('uses existing authorized thread room semantics', async () => {
    const scope = create(ScopeReferenceSchema, {
      kind: ScopeKind.THREAD_PRESENCE,
      id: 'thread-1',
    });
    const fixture = socketFixture(retention());
    let response: Uint8Array | undefined;
    await fixture.socket.triggerRpc<Uint8Array>(
      BROWSER_V1_CARRIER_EVENTS.event,
      requestWire(scope),
      (wire) => {
        response = wire;
      },
    );
    expect(decodeEventEnvelope(response!)).toMatchObject({
      case: 'subscriptionOutcome',
      value: { outcome: { case: 'accepted' } },
    });
    expect(fixture.joined).toContain('thread:thread-1:presence');
  });

  test('returns non-disclosing authorization and explicit gap outcomes', async () => {
    const deniedScope = create(ScopeReferenceSchema, { kind: ScopeKind.USER, id: 'user-2' });
    const denied = socketFixture(retention());
    let deniedResponse: Uint8Array | undefined;
    await denied.socket.triggerRpc<Uint8Array>(
      BROWSER_V1_CARRIER_EVENTS.event,
      requestWire(deniedScope),
      (wire) => {
        deniedResponse = wire;
      },
    );
    expect(decodeEventEnvelope(deniedResponse!)).toMatchObject({
      case: 'subscriptionOutcome',
      value: { outcome: { case: 'status', value: { code: StatusCode.NOT_FOUND } } },
    });

    const store = retention(1);
    const scope = create(ScopeReferenceSchema, { kind: ScopeKind.USER, id: 'user-1' });
    store.append(scope, durableEvent());
    const gap = socketFixture(store);
    let gapResponse: Uint8Array | undefined;
    await gap.socket.triggerRpc<Uint8Array>(
      BROWSER_V1_CARRIER_EVENTS.event,
      requestWire(scope, 0n),
      (wire) => {
        gapResponse = wire;
      },
    );
    expect(decodeEventEnvelope(gapResponse!)).toMatchObject({
      case: 'subscriptionOutcome',
      value: { outcome: { case: 'status', value: { code: StatusCode.GAP } } },
    });
  });
});
