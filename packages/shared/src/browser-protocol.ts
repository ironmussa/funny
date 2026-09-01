import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { z } from 'zod';

import {
  StatusCode,
  StatusSchema,
  type Status,
} from './generated/browser-v1/browser/v1/common_pb.js';
import {
  CarrierEnvelopeSchema,
  type CarrierEnvelope,
} from './generated/browser-v1/browser/v1/transport_pb.js';

export const BROWSER_V1_PROTOCOL_MAJOR = 1;
export const BROWSER_V1_PROTOCOL_MINOR = 0;
export const BROWSER_V1_SCHEMA_FINGERPRINT =
  'browser.v1:sha256:83a609b2bac5db1a13fe1d90bf377f299dc91e31392d4f0ab4ff0db57d96fe1a';

export const BROWSER_V1_CARRIER_EVENTS = {
  negotiate: 'browser:v1:negotiate',
  operation: 'browser:v1:operation',
  event: 'browser:v1:event',
  interactive: 'browser:v1:interactive',
  control: 'browser:v1:control',
} as const;

export type BrowserV1CarrierEvent =
  (typeof BROWSER_V1_CARRIER_EVENTS)[keyof typeof BROWSER_V1_CARRIER_EVENTS];

export const BROWSER_V1_DEFAULT_MAX_MESSAGE_BYTES = 2 * 1024 * 1024;

export type BrowserCarrierPayloadCase = Exclude<CarrierEnvelope['payload']['case'], undefined>;

export type BrowserCarrierDecodeResult =
  | { ok: true; envelope: CarrierEnvelope; byteLength: number }
  | { ok: false; status: Status };

function safeStatus(code: StatusCode, message: string, retryable = false): Status {
  return create(StatusSchema, { code, message, retryable });
}

export function normalizeBrowserCarrierPayload(payload: unknown): Uint8Array | null {
  if (payload instanceof Uint8Array) {
    return new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
  }
  if (payload instanceof ArrayBuffer) return new Uint8Array(payload);
  if (ArrayBuffer.isView(payload)) {
    return new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
  }
  return null;
}

export const browserCarrierPayloadSchema = z.custom<Uint8Array | ArrayBuffer | ArrayBufferView>(
  (payload) => normalizeBrowserCarrierPayload(payload) !== null,
  'Expected binary payload',
);

function validateEnvelope(envelope: CarrierEnvelope): Status | null {
  if (!envelope.generatedSchemaFingerprint || envelope.generatedSchemaFingerprint.length > 160) {
    return safeStatus(StatusCode.MALFORMED_INPUT, 'Invalid generated schema fingerprint');
  }

  switch (envelope.payload.case) {
    case 'negotiationRequest':
      if (
        envelope.payload.value.supportedVersions.length === 0 ||
        !envelope.payload.value.generatedSchemaFingerprint ||
        !envelope.payload.value.client?.instanceId
      ) {
        return safeStatus(StatusCode.MALFORMED_INPUT, 'Invalid negotiation request');
      }
      return null;
    case 'negotiationOutcome':
      return envelope.payload.value.outcome.case
        ? null
        : safeStatus(StatusCode.MALFORMED_INPUT, 'Negotiation outcome is missing its result');
    case 'operation': {
      const operation = envelope.payload.value.payload;
      if (operation.case === 'request') {
        return operation.value.metadata?.requestId && operation.value.operation.case
          ? null
          : safeStatus(StatusCode.MALFORMED_INPUT, 'Operation request is incomplete');
      }
      if (operation.case === 'outcome') {
        return operation.value.requestId && operation.value.outcome.case
          ? null
          : safeStatus(StatusCode.MALFORMED_INPUT, 'Operation outcome is incomplete');
      }
      return safeStatus(StatusCode.MALFORMED_INPUT, 'Operation envelope is empty');
    }
    case 'event':
      return envelope.payload.value.payload.case
        ? null
        : safeStatus(StatusCode.MALFORMED_INPUT, 'Event envelope is empty');
    case 'interactive':
      return envelope.payload.value.payload.case
        ? null
        : safeStatus(StatusCode.MALFORMED_INPUT, 'Interactive envelope is empty');
    case 'control':
      return envelope.payload.value.payload.case
        ? null
        : safeStatus(StatusCode.MALFORMED_INPUT, 'Control envelope is empty');
    default:
      return safeStatus(StatusCode.MALFORMED_INPUT, 'Unknown browser.v1 message');
  }
}

export function decodeBrowserCarrier(
  payload: unknown,
  options: {
    maxMessageBytes?: number;
    expectedSchemaFingerprint?: string;
    allowedPayloads?: readonly BrowserCarrierPayloadCase[];
  } = {},
): BrowserCarrierDecodeResult {
  const bytes = normalizeBrowserCarrierPayload(payload);
  if (!bytes || bytes.byteLength === 0) {
    return { ok: false, status: safeStatus(StatusCode.MALFORMED_INPUT, 'Expected binary payload') };
  }
  const maxMessageBytes = options.maxMessageBytes ?? BROWSER_V1_DEFAULT_MAX_MESSAGE_BYTES;
  if (bytes.byteLength > maxMessageBytes) {
    return {
      ok: false,
      status: safeStatus(StatusCode.RESOURCE_EXHAUSTED, 'Binary payload exceeds configured limit'),
    };
  }

  let envelope: CarrierEnvelope;
  try {
    envelope = fromBinary(CarrierEnvelopeSchema, bytes);
  } catch {
    return {
      ok: false,
      status: safeStatus(StatusCode.MALFORMED_INPUT, 'Malformed browser.v1 payload'),
    };
  }

  const invalid = validateEnvelope(envelope);
  if (invalid) return { ok: false, status: invalid };
  if (
    options.expectedSchemaFingerprint &&
    envelope.generatedSchemaFingerprint !== options.expectedSchemaFingerprint
  ) {
    return {
      ok: false,
      status: safeStatus(StatusCode.INCOMPATIBLE, 'Generated schema identity is incompatible'),
    };
  }
  if (
    options.allowedPayloads &&
    !options.allowedPayloads.includes(envelope.payload.case as BrowserCarrierPayloadCase)
  ) {
    return {
      ok: false,
      status: safeStatus(StatusCode.MALFORMED_INPUT, 'Message is not valid for this carrier event'),
    };
  }
  return { ok: true, envelope, byteLength: bytes.byteLength };
}

export function encodeBrowserCarrier(envelope: CarrierEnvelope): Uint8Array {
  const invalid = validateEnvelope(envelope);
  if (invalid) throw new TypeError(invalid.message);
  return toBinary(CarrierEnvelopeSchema, envelope);
}

export function encodeBrowserStatus(status: Status): Uint8Array {
  return encodeBrowserCarrier(
    create(CarrierEnvelopeSchema, {
      generatedSchemaFingerprint: BROWSER_V1_SCHEMA_FINGERPRINT,
      payload: {
        case: 'control',
        value: { payload: { case: 'status', value: status } },
      },
    }),
  );
}
