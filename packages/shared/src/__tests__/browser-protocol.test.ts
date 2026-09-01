import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';

import { create, fromBinary } from '@bufbuild/protobuf';

import {
  BROWSER_V1_CARRIER_EVENTS,
  BROWSER_V1_SCHEMA_FINGERPRINT,
  decodeBrowserCarrier,
  encodeBrowserCarrier,
  encodeBrowserStatus,
  normalizeBrowserCarrierPayload,
} from '../browser-protocol.js';
import { StatusCode, StatusSchema } from '../generated/browser-v1/browser/v1/common_pb.js';
import { CarrierEnvelopeSchema } from '../generated/browser-v1/browser/v1/transport_pb.js';

function negotiationEnvelope() {
  return create(CarrierEnvelopeSchema, {
    generatedSchemaFingerprint: BROWSER_V1_SCHEMA_FINGERPRINT,
    payload: {
      case: 'negotiationRequest',
      value: {
        generatedSchemaFingerprint: BROWSER_V1_SCHEMA_FINGERPRINT,
        supportedVersions: [{ major: 1, minor: 0 }],
        client: { instanceId: 'test-client', applicationVersion: 'test', deployment: 'web' },
      },
    },
  });
}

describe('browser.v1 carrier codec', () => {
  test('uses a small stable carrier event set', () => {
    expect(BROWSER_V1_CARRIER_EVENTS).toEqual({
      negotiate: 'browser:v1:negotiate',
      operation: 'browser:v1:operation',
      event: 'browser:v1:event',
      interactive: 'browser:v1:interactive',
      control: 'browser:v1:control',
    });
  });

  test('normalizes browser, WebView, and Node binary views', () => {
    const bytes = Uint8Array.of(1, 2, 3, 4);
    expect(normalizeBrowserCarrierPayload(bytes)).toEqual(bytes);
    expect(normalizeBrowserCarrierPayload(bytes.buffer)).toEqual(bytes);
    expect(normalizeBrowserCarrierPayload(new DataView(bytes.buffer, 1, 2))).toEqual(
      Uint8Array.of(2, 3),
    );
    expect(normalizeBrowserCarrierPayload({ 0: 1, length: 1 })).toBeNull();
  });

  test('round-trips a binary attachment without Socket.IO packet coupling', () => {
    const wire = encodeBrowserCarrier(negotiationEnvelope());
    const result = decodeBrowserCarrier(wire, {
      expectedSchemaFingerprint: BROWSER_V1_SCHEMA_FINGERPRINT,
      allowedPayloads: ['negotiationRequest'],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.envelope.payload.case).toBe('negotiationRequest');
  });

  test('rejects malformed, oversized, empty, and wrong-carrier messages before dispatch', () => {
    expect(decodeBrowserCarrier('not-binary').ok).toBe(false);
    expect(decodeBrowserCarrier(Uint8Array.of(0xff)).ok).toBe(false);
    expect(decodeBrowserCarrier(new Uint8Array()).ok).toBe(false);
    expect(
      decodeBrowserCarrier(encodeBrowserCarrier(negotiationEnvelope()), { maxMessageBytes: 1 }),
    ).toMatchObject({ ok: false, status: { code: StatusCode.RESOURCE_EXHAUSTED } });
    expect(
      decodeBrowserCarrier(encodeBrowserCarrier(negotiationEnvelope()), {
        allowedPayloads: ['operation'],
      }),
    ).toMatchObject({ ok: false, status: { code: StatusCode.MALFORMED_INPUT } });
  });

  test('rejects incompatible schema identity and unknown message payloads', () => {
    expect(
      decodeBrowserCarrier(encodeBrowserCarrier(negotiationEnvelope()), {
        expectedSchemaFingerprint: 'browser.v1:sha256:different',
      }),
    ).toMatchObject({ ok: false, status: { code: StatusCode.INCOMPATIBLE } });
    expect(decodeBrowserCarrier(Uint8Array.of(0x98, 0x06, 0x01))).toMatchObject({
      ok: false,
      status: { code: StatusCode.MALFORMED_INPUT },
    });
  });

  test('encodes safe typed statuses', () => {
    const wire = encodeBrowserStatus(
      create(StatusSchema, {
        code: StatusCode.UNAUTHENTICATED,
        message: 'Authentication required',
      }),
    );
    const decoded = fromBinary(CarrierEnvelopeSchema, wire);
    expect(decoded.payload).toMatchObject({
      case: 'control',
      value: { payload: { case: 'status', value: { code: StatusCode.UNAUTHENTICATED } } },
    });
  });

  test('schema identity matches the committed portable descriptor', async () => {
    const descriptor = await Bun.file(
      new URL('../../../../protocol/browser/v1/fixtures/schema.binpb', import.meta.url),
    ).arrayBuffer();
    const digest = createHash('sha256').update(new Uint8Array(descriptor)).digest('hex');
    expect(BROWSER_V1_SCHEMA_FINGERPRINT).toBe(`browser.v1:sha256:${digest}`);
  });
});
