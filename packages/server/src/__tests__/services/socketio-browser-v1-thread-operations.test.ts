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
import { Representation, ResourceKind, StatusCode } from '@funny/shared/browser-v1/common';
import { OperationRequestSchema } from '@funny/shared/browser-v1/operations';
import { CarrierEnvelopeSchema } from '@funny/shared/browser-v1/transport';

import { BrowserV1IdempotencyStore } from '../../services/socketio/browser-v1-idempotency.js';
import { setupBrowserV1Operations } from '../../services/socketio/browser-v1-operations.js';
import { __resetPresenceForTests } from '../../services/socketio/thread-presence.js';
import { createMockSocket } from '../helpers/socketio-test-mocks.js';

function requestWire(
  kind: 'threadOpen' | 'threadClose',
  requestId: string,
  idempotencyKey?: string,
) {
  return encodeBrowserCarrier(
    create(CarrierEnvelopeSchema, {
      generatedSchemaFingerprint: BROWSER_V1_SCHEMA_FINGERPRINT,
      payload: {
        case: 'operation',
        value: {
          payload: {
            case: 'request',
            value: create(OperationRequestSchema, {
              metadata: { requestId, idempotencyKey },
              operation: { case: kind, value: { threadId: 'thread-1' } },
            }),
          },
        },
      },
    }),
  );
}

function decodeOutcome(wire: Uint8Array) {
  const envelope = fromBinary(CarrierEnvelopeSchema, wire);
  if (envelope.payload.case !== 'operation' || envelope.payload.value.payload.case !== 'outcome') {
    throw new Error('Expected operation outcome');
  }
  return envelope.payload.value.payload.value;
}

function socketFixture(idempotency?: BrowserV1IdempotencyStore) {
  const joined: string[] = [];
  const left: string[] = [];
  const socket = createMockSocket({
    data: {
      browserV1: {
        principalUserId: 'user-1',
        assignments: { operations: Representation.BROWSER_V1 },
      },
    },
    join: (room: string) => joined.push(room),
    leave: (room: string) => left.push(room),
    to: () => ({ emit: () => {} }),
  } as any);
  setupBrowserV1Operations(socket, 'user-1', {
    findAnyRunnerForUser: async () => null,
    getRunnerUserId: async () => null,
    idempotency,
  });
  return { socket, joined, left };
}

describe('browser.v1 thread lifecycle operations', () => {
  beforeEach(() => {
    canView = true;
    __resetPresenceForTests();
  });

  test('shares authorized room lifecycle and returns causal revisions', async () => {
    const fixture = socketFixture();
    let openResponse: Uint8Array | undefined;
    await fixture.socket.triggerRpc<Uint8Array>(
      BROWSER_V1_CARRIER_EVENTS.operation,
      requestWire('threadOpen', 'open-1'),
      (wire) => {
        openResponse = wire;
      },
    );
    const opened = decodeOutcome(openResponse!);
    expect(fixture.joined).toContain('thread:thread-1:presence');
    expect(opened).toMatchObject({
      requestId: 'open-1',
      revisions: [
        {
          resource: { kind: ResourceKind.THREAD, id: 'thread-1' },
          revision: 1n,
          causalRequestId: 'open-1',
        },
      ],
      outcome: {
        case: 'success',
        value: {
          result: {
            case: 'threadLifecycle',
            value: { threadId: 'thread-1', open: true, presenceRevision: 1n },
          },
        },
      },
    });

    let closeResponse: Uint8Array | undefined;
    await fixture.socket.triggerRpc<Uint8Array>(
      BROWSER_V1_CARRIER_EVENTS.operation,
      requestWire('threadClose', 'close-1'),
      (wire) => {
        closeResponse = wire;
      },
    );
    expect(fixture.left).toContain('thread:thread-1:presence');
    expect(decodeOutcome(closeResponse!)).toMatchObject({
      revisions: [{ revision: 2n, causalRequestId: 'close-1' }],
      outcome: {
        case: 'success',
        value: { result: { case: 'threadLifecycle', value: { open: false } } },
      },
    });
  });

  test('returns a non-disclosing status when thread access is denied', async () => {
    canView = false;
    const fixture = socketFixture();
    let response: Uint8Array | undefined;
    await fixture.socket.triggerRpc<Uint8Array>(
      BROWSER_V1_CARRIER_EVENTS.operation,
      requestWire('threadOpen', 'denied-1'),
      (wire) => {
        response = wire;
      },
    );
    expect(decodeOutcome(response!).outcome).toMatchObject({
      case: 'status',
      value: { code: StatusCode.NOT_FOUND, message: 'Thread is unavailable' },
    });
    expect(fixture.joined).toHaveLength(0);
  });

  test('replays a committed outcome after reconnect and rejects key reuse conflicts', async () => {
    const idempotency = new BrowserV1IdempotencyStore({
      retentionMs: 60_000,
      maxEntries: 100,
    });
    const first = socketFixture(idempotency);
    let firstResponse: Uint8Array | undefined;
    await first.socket.triggerRpc<Uint8Array>(
      BROWSER_V1_CARRIER_EVENTS.operation,
      requestWire('threadOpen', 'open-original', 'thread-lifecycle-1'),
      (wire) => {
        firstResponse = wire;
      },
    );

    const reconnected = socketFixture(idempotency);
    let replayResponse: Uint8Array | undefined;
    await reconnected.socket.triggerRpc<Uint8Array>(
      BROWSER_V1_CARRIER_EVENTS.operation,
      requestWire('threadOpen', 'open-retry', 'thread-lifecycle-1'),
      (wire) => {
        replayResponse = wire;
      },
    );
    expect(decodeOutcome(replayResponse!)).toEqual(decodeOutcome(firstResponse!));
    expect(reconnected.joined).toHaveLength(0);

    let conflictResponse: Uint8Array | undefined;
    await reconnected.socket.triggerRpc<Uint8Array>(
      BROWSER_V1_CARRIER_EVENTS.operation,
      requestWire('threadClose', 'close-conflict', 'thread-lifecycle-1'),
      (wire) => {
        conflictResponse = wire;
      },
    );
    expect(decodeOutcome(conflictResponse!).outcome).toMatchObject({
      case: 'status',
      value: { code: StatusCode.CONFLICT },
    });
    expect(reconnected.left).toHaveLength(0);
  });
});
