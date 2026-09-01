import { describe, expect, test } from 'bun:test';

import { create, fromBinary } from '@bufbuild/protobuf';
import {
  BROWSER_V1_CARRIER_EVENTS,
  BROWSER_V1_SCHEMA_FINGERPRINT,
  encodeBrowserCarrier,
} from '@funny/shared/browser-protocol';
import { BrowserCapability, Representation, StatusCode } from '@funny/shared/browser-v1/common';
import { CarrierEnvelopeSchema } from '@funny/shared/browser-v1/transport';

import {
  negotiateBrowserV1,
  setupBrowserV1Negotiation,
} from '../../services/socketio/browser-v1-negotiation.js';
import { createMockSocket } from '../helpers/socketio-test-mocks.js';

function requestWire(options?: { fingerprint?: string; major?: number }): Uint8Array {
  return encodeBrowserCarrier(
    create(CarrierEnvelopeSchema, {
      generatedSchemaFingerprint: options?.fingerprint ?? BROWSER_V1_SCHEMA_FINGERPRINT,
      payload: {
        case: 'negotiationRequest',
        value: {
          supportedVersions: [{ major: options?.major ?? 1, minor: 0 }],
          generatedSchemaFingerprint: options?.fingerprint ?? BROWSER_V1_SCHEMA_FINGERPRINT,
          capabilities: [BrowserCapability.OPERATIONS, BrowserCapability.EVENTS],
          client: { instanceId: 'client-1', applicationVersion: 'test', deployment: 'web' },
        },
      },
    }),
  );
}

describe('browser.v1 negotiation', () => {
  test('derives principal from the authenticated connection and keeps all traffic legacy', () => {
    const request = fromBinary(CarrierEnvelopeSchema, requestWire()).payload;
    if (request.case !== 'negotiationRequest') throw new Error('fixture mismatch');
    const result = negotiateBrowserV1('user-1', request.value);

    expect(result.outcome.outcome.case).toBe('success');
    expect(result.state).toMatchObject({
      principalUserId: 'user-1',
      assignments: {
        operations: Representation.LEGACY,
        events: Representation.LEGACY,
        terminal: Representation.LEGACY,
        browserSession: Representation.LEGACY,
      },
    });
  });

  test('rejects unauthenticated, unsupported, and mismatched-schema activation safely', () => {
    const valid = fromBinary(CarrierEnvelopeSchema, requestWire()).payload;
    const unsupported = fromBinary(CarrierEnvelopeSchema, requestWire({ major: 2 })).payload;
    const mismatched = fromBinary(
      CarrierEnvelopeSchema,
      requestWire({ fingerprint: 'browser.v1:sha256:different' }),
    ).payload;
    if (
      valid.case !== 'negotiationRequest' ||
      unsupported.case !== 'negotiationRequest' ||
      mismatched.case !== 'negotiationRequest'
    ) {
      throw new Error('fixture mismatch');
    }
    expect(negotiateBrowserV1(undefined, valid.value).outcome).toMatchObject({
      outcome: { case: 'status', value: { code: StatusCode.UNAUTHENTICATED } },
    });
    expect(negotiateBrowserV1('user-1', unsupported.value).outcome).toMatchObject({
      outcome: { case: 'status', value: { code: StatusCode.INCOMPATIBLE } },
    });
    expect(negotiateBrowserV1('user-1', mismatched.value).outcome).toMatchObject({
      outcome: { case: 'status', value: { code: StatusCode.INCOMPATIBLE } },
    });
  });

  test('acknowledges with binary and stores connection-local negotiation state', async () => {
    const socket = createMockSocket({ data: {} } as any);
    setupBrowserV1Negotiation(socket, 'user-1');

    let response: Uint8Array | undefined;
    await socket.triggerRpc<Uint8Array>(
      BROWSER_V1_CARRIER_EVENTS.negotiate,
      requestWire(),
      (wire) => {
        response = wire;
      },
    );

    expect(response).toBeInstanceOf(Uint8Array);
    expect(fromBinary(CarrierEnvelopeSchema, response!).payload.case).toBe('negotiationOutcome');
    expect(socket.data.browserV1).toMatchObject({ principalUserId: 'user-1' });
  });

  test('returns a typed binary status for malformed input without activating state', async () => {
    const socket = createMockSocket({ data: {} } as any);
    setupBrowserV1Negotiation(socket, 'user-1');

    let response: Uint8Array | undefined;
    await socket.triggerRpc<Uint8Array>(
      BROWSER_V1_CARRIER_EVENTS.negotiate,
      Uint8Array.of(0xff),
      (wire) => {
        response = wire;
      },
    );

    const decoded = fromBinary(CarrierEnvelopeSchema, response!);
    expect(decoded.payload).toMatchObject({
      case: 'control',
      value: { payload: { case: 'status', value: { code: StatusCode.MALFORMED_INPUT } } },
    });
    expect(socket.data.browserV1).toBeUndefined();
  });
});
