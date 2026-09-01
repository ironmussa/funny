import { describe, expect, test } from 'bun:test';

import { create } from '@bufbuild/protobuf';
import { BROWSER_V1_CARRIER_EVENTS, decodeBrowserCarrier } from '@funny/shared/browser-protocol';
import {
  DeliveryClass,
  Representation,
  ScopeKind,
  StatusCode,
} from '@funny/shared/browser-v1/common';
import { ApplicationEventSchema } from '@funny/shared/browser-v1/events';

import {
  SocketIoBrowserEventSink,
  type BrowserSinkTelemetry,
} from '../../services/socketio/browser-event-sink.js';

function typedEvent() {
  return create(ApplicationEventSchema, {
    metadata: {
      eventId: 'event-1',
      scope: { kind: ScopeKind.USER, id: 'user-1' },
      sequence: 1n,
      revision: 1n,
    },
    delivery: { deliveryClass: DeliveryClass.SNAPSHOT_RECOVERABLE },
    payload: { case: 'user', value: { eventType: 'profile:updated' } },
  });
}

function socket(id: string) {
  const emitted: Array<{ event: string; payload: unknown }> = [];
  return {
    id,
    data: {},
    emitted,
    emit(event: string, payload: unknown) {
      emitted.push({ event, payload });
    },
  };
}

describe('rollout-aware browser event sink', () => {
  test('dispatches exactly one selected representation per client', () => {
    const legacy = socket('legacy');
    const binary = socket('binary');
    const shadow = socket('shadow');
    const sockets = new Map([
      [legacy.id, legacy],
      [binary.id, binary],
      [shadow.id, shadow],
    ]);
    const browser = {
      sockets,
      adapter: { rooms: new Map([['user:user-1', new Set(sockets.keys())]]) },
    };
    const telemetry: BrowserSinkTelemetry[] = [];
    const sink = new SocketIoBrowserEventSink({ of: () => browser } as any, {
      selectRepresentation: (candidate) =>
        candidate.id === 'binary'
          ? Representation.BROWSER_V1
          : candidate.id === 'shadow'
            ? Representation.SHADOW
            : Representation.LEGACY,
      telemetry: (event) => telemetry.push(event),
    });

    sink.publish({
      scope: { kind: 'user', userId: 'user-1' },
      logicalType: 'profile:updated',
      trafficClass: 'events',
      delivery: { class: 'snapshot-recoverable' },
      legacyEvent: { type: 'profile:updated', nickname: 'Ada' },
      browserV1: typedEvent(),
    });

    expect(legacy.emitted.map(({ event }) => event)).toEqual(['profile:updated']);
    expect(binary.emitted.map(({ event }) => event)).toEqual([BROWSER_V1_CARRIER_EVENTS.event]);
    expect(shadow.emitted.map(({ event }) => event)).toEqual(['profile:updated']);
    expect(decodeBrowserCarrier(binary.emitted[0]?.payload)).toMatchObject({
      ok: true,
      envelope: { payload: { case: 'event' } },
    });
    expect(telemetry).toContainEqual(
      expect.objectContaining({ representation: 'shadow', dispatched: false }),
    );
  });

  test('evicts revoked sharees and sends typed outcomes to binary subscribers', () => {
    const binary = socket('binary');
    binary.data = { browserV1: { assignments: { events: Representation.BROWSER_V1 } } };
    const sockets = new Map([[binary.id, binary]]);
    const socketsLeave: string[][] = [];
    const browser = {
      sockets,
      adapter: { rooms: new Map([['user:user-1', new Set(sockets.keys())]]) },
      in: () => ({ socketsLeave: (rooms: string[]) => socketsLeave.push(rooms) }),
    };
    const sink = new SocketIoBrowserEventSink({ of: () => browser } as any);

    sink.evictFromThread('user-1', 'thread-1');

    expect(socketsLeave).toEqual([['thread:thread-1:stream', 'thread:thread-1:presence']]);
    expect(binary.emitted.map(({ event }) => event)).toEqual([
      BROWSER_V1_CARRIER_EVENTS.event,
      BROWSER_V1_CARRIER_EVENTS.event,
    ]);
    const outcomes = binary.emitted.map(({ payload }) => decodeBrowserCarrier(payload));
    expect(outcomes).toMatchObject([
      {
        ok: true,
        envelope: {
          payload: {
            case: 'event',
            value: {
              payload: {
                case: 'subscriptionOutcome',
                value: {
                  scope: { kind: ScopeKind.THREAD_STREAM },
                  outcome: {
                    case: 'status',
                    value: { code: StatusCode.REVOKED },
                  },
                },
              },
            },
          },
        },
      },
      {
        ok: true,
        envelope: {
          payload: {
            case: 'event',
            value: {
              payload: {
                case: 'subscriptionOutcome',
                value: {
                  scope: { kind: ScopeKind.THREAD_PRESENCE },
                  outcome: {
                    case: 'status',
                    value: { code: StatusCode.REVOKED },
                  },
                },
              },
            },
          },
        },
      },
    ]);
  });

  test('bounds a slow binary consumer and reports resource exhaustion', () => {
    const slow = socket('slow') as ReturnType<typeof socket> & {
      conn: { transport: { writable: boolean; once: () => void } };
      once: () => void;
    };
    slow.data = { browserV1: { assignments: { events: Representation.BROWSER_V1 } } };
    slow.conn = { transport: { writable: false, once: () => {} } };
    slow.once = () => {};
    const sockets = new Map([[slow.id, slow]]);
    const browser = {
      sockets,
      adapter: { rooms: new Map([['user:user-1', new Set(sockets.keys())]]) },
    };
    const telemetry: BrowserSinkTelemetry[] = [];
    const sink = new SocketIoBrowserEventSink({ of: () => browser } as any, {
      telemetry: (event) => telemetry.push(event),
    });
    const publication = {
      scope: { kind: 'user' as const, userId: 'user-1' },
      logicalType: 'profile:updated',
      trafficClass: 'events' as const,
      delivery: { class: 'durable' as const },
      legacyEvent: { type: 'profile:updated' },
      browserV1: typedEvent(),
    };

    for (let index = 0; index < 262; index += 1) sink.publish(publication);

    expect(
      slow.emitted.filter(({ event }) => event === BROWSER_V1_CARRIER_EVENTS.event),
    ).toHaveLength(4);
    expect(slow.emitted.some(({ event }) => event === BROWSER_V1_CARRIER_EVENTS.control)).toBe(
      true,
    );
    expect(telemetry.some(({ reason }) => reason === 'exhausted')).toBe(true);
  });
});
