import { create } from '@bufbuild/protobuf';
import {
  BROWSER_V1_CARRIER_EVENTS,
  BROWSER_V1_PROTOCOL_MAJOR,
  BROWSER_V1_PROTOCOL_MINOR,
  BROWSER_V1_SCHEMA_FINGERPRINT,
  browserCarrierPayloadSchema,
  decodeBrowserCarrier,
} from '@funny/shared/browser-protocol';
import {
  BrowserCapability,
  Representation,
  ScopeKind,
  StatusCode,
  StatusSchema,
  TrafficClass,
} from '@funny/shared/browser-v1/common';
import {
  NegotiationOutcomeSchema,
  type NegotiationRequest,
  type NegotiationOutcome,
} from '@funny/shared/browser-v1/negotiation';
import { CarrierEnvelopeSchema } from '@funny/shared/browser-v1/transport';
import type { Socket } from 'socket.io';

import { observeBrowserV1 } from './browser-v1-observability.js';
import { BrowserV1RolloutPolicy } from './browser-v1-rollout.js';
import { encodeSocketIoCarrier, encodeSocketIoStatus } from './browser-v1-wire.js';
import { registerSocketRpc } from './router.js';

const SERVER_CAPABILITIES = new Set([
  BrowserCapability.OPERATIONS,
  BrowserCapability.EVENTS,
  BrowserCapability.TERMINAL,
  BrowserCapability.BROWSER_SESSION,
  BrowserCapability.CURSOR_RECOVERY,
  BrowserCapability.BINARY_POLLING,
]);

export interface BrowserV1ConnectionState {
  principalUserId: string;
  protocolMajor: number;
  protocolMinor: number;
  generatedSchemaFingerprint: string;
  capabilities: BrowserCapability[];
  maxPendingOperations: number;
  assignments: Record<'operations' | 'events' | 'terminal' | 'browserSession', Representation>;
}

function negotiationStatus(code: StatusCode, message: string): NegotiationOutcome {
  return create(NegotiationOutcomeSchema, {
    outcome: { case: 'status', value: create(StatusSchema, { code, message }) },
  });
}

export function negotiateBrowserV1(
  principalUserId: string | undefined,
  request: NegotiationRequest,
  rollout = new BrowserV1RolloutPolicy({
    operations: 'legacy',
    events: 'legacy',
    terminal: 'legacy',
    browserSession: 'legacy',
  }),
): { outcome: NegotiationOutcome; state?: BrowserV1ConnectionState } {
  if (!principalUserId) {
    return {
      outcome: negotiationStatus(StatusCode.UNAUTHENTICATED, 'Authenticated session required'),
    };
  }
  const selected = request.supportedVersions
    .filter((version) => version.major === BROWSER_V1_PROTOCOL_MAJOR)
    .sort((left, right) => right.minor - left.minor)
    .find((version) => version.minor <= BROWSER_V1_PROTOCOL_MINOR);
  if (!selected) {
    return {
      outcome: negotiationStatus(
        StatusCode.INCOMPATIBLE,
        `Supported browser protocol range is ${BROWSER_V1_PROTOCOL_MAJOR}.0-${BROWSER_V1_PROTOCOL_MAJOR}.${BROWSER_V1_PROTOCOL_MINOR}`,
      ),
    };
  }
  if (request.generatedSchemaFingerprint !== BROWSER_V1_SCHEMA_FINGERPRINT) {
    return {
      outcome: negotiationStatus(
        StatusCode.INCOMPATIBLE,
        'Generated browser schema identity is incompatible',
      ),
    };
  }

  const capabilities = [...new Set(request.capabilities)].filter((capability) =>
    SERVER_CAPABILITIES.has(capability),
  );
  const assignments = rollout.assignments({
    protocolMajor: selected.major,
    client: request.client,
    capabilities,
  });
  const outcome = create(NegotiationOutcomeSchema, {
    outcome: {
      case: 'success',
      value: {
        selectedVersion: { major: selected.major, minor: selected.minor },
        generatedSchemaFingerprint: BROWSER_V1_SCHEMA_FINGERPRINT,
        enabledCapabilities: capabilities,
        assignments: [
          { trafficClass: TrafficClass.OPERATIONS, representation: assignments.operations },
          { trafficClass: TrafficClass.EVENTS, representation: assignments.events },
          { trafficClass: TrafficClass.TERMINAL, representation: assignments.terminal },
          {
            trafficClass: TrafficClass.BROWSER_SESSION,
            representation: assignments.browserSession,
          },
        ],
        effectiveLimits: {
          maxMessageBytes: 2 * 1024 * 1024,
          maxPendingOperations: 32,
          maxQueuedMessagesPerClass: 256,
          maxQueuedBytesPerClass: BigInt(4 * 1024 * 1024),
          reservedControlMessages: 16,
        },
        heartbeatInterval: { seconds: 25n },
        heartbeatTimeout: { seconds: 20n },
        acceptedCursors: request.resumeCursors.filter(
          (cursor) => cursor.scope?.kind === ScopeKind.USER && cursor.scope.id === principalUserId,
        ),
      },
    },
  });
  return {
    outcome,
    state: {
      principalUserId,
      protocolMajor: selected.major,
      protocolMinor: selected.minor,
      generatedSchemaFingerprint: BROWSER_V1_SCHEMA_FINGERPRINT,
      capabilities,
      maxPendingOperations: 32,
      assignments,
    },
  };
}

export function setupBrowserV1Negotiation(
  socket: Socket,
  principalUserId: string,
  rollout?: BrowserV1RolloutPolicy,
): void {
  registerSocketRpc<Uint8Array, typeof browserCarrierPayloadSchema>(
    socket,
    BROWSER_V1_CARRIER_EVENTS.negotiate,
    {
      payloadSchema: browserCarrierPayloadSchema,
      invalidPayloadResponse: encodeSocketIoStatus(
        create(StatusSchema, {
          code: StatusCode.MALFORMED_INPUT,
          message: 'Expected binary negotiation payload',
        }),
      ),
      handler: (_ctx, acknowledge, payload) => {
        const decoded = decodeBrowserCarrier(payload, {
          allowedPayloads: ['negotiationRequest'],
        });
        if (!decoded.ok) {
          observeBrowserV1({
            event: 'decode',
            status: 'rejected',
            trafficClass: 'operations',
            reason: decoded.status.code.toString(),
          });
          acknowledge(encodeSocketIoStatus(decoded.status));
          return;
        }
        const request = decoded.envelope.payload;
        if (request.case !== 'negotiationRequest') return;

        const negotiated = negotiateBrowserV1(principalUserId, request.value, rollout);
        observeBrowserV1({
          event: 'negotiation',
          status: negotiated.state ? 'ok' : 'rejected',
          transport: socket.conn?.transport?.name ?? 'unknown',
          payloadBytes: payload.byteLength,
        });
        if (negotiated.state) socket.data.browserV1 = negotiated.state;
        acknowledge(
          encodeSocketIoCarrier(
            create(CarrierEnvelopeSchema, {
              generatedSchemaFingerprint: BROWSER_V1_SCHEMA_FINGERPRINT,
              payload: { case: 'negotiationOutcome', value: negotiated.outcome },
            }),
          ),
        );
      },
    },
  );
}
