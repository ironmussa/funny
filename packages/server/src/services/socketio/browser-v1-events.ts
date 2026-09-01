import { create } from '@bufbuild/protobuf';
import {
  BROWSER_V1_CARRIER_EVENTS,
  BROWSER_V1_SCHEMA_FINGERPRINT,
  browserCarrierPayloadSchema,
  decodeBrowserCarrier,
} from '@funny/shared/browser-protocol';
import {
  Representation,
  ScopeKind,
  StatusCode,
  StatusSchema,
  type ScopeReference,
} from '@funny/shared/browser-v1/common';
import {
  EventEnvelopeSchema,
  SubscriptionOutcomeSchema,
  type EventEnvelope,
} from '@funny/shared/browser-v1/events';
import { CarrierEnvelopeSchema } from '@funny/shared/browser-v1/transport';
import type { Socket } from 'socket.io';

import { canUserViewThread } from '../thread-access-check.js';
import {
  browserV1EventRetention,
  type BrowserEventResume,
  type BrowserV1EventRetention,
} from './browser-v1-event-retention.js';
import { observeBrowserV1 } from './browser-v1-observability.js';
import { encodeSocketIoCarrier, encodeSocketIoStatus } from './browser-v1-wire.js';
import { registerSocketRpc } from './router.js';
import { openThreadForSocket } from './thread-presence.js';

function encodeEventPayload(payload: EventEnvelope['payload']) {
  return encodeSocketIoCarrier(
    create(CarrierEnvelopeSchema, {
      generatedSchemaFingerprint: BROWSER_V1_SCHEMA_FINGERPRINT,
      payload: { case: 'event', value: create(EventEnvelopeSchema, { payload }) },
    }),
  );
}

function statusOutcome(scope: ScopeReference, code: StatusCode, message: string) {
  return create(SubscriptionOutcomeSchema, {
    scope,
    outcome: { case: 'status', value: create(StatusSchema, { code, message }) },
  });
}

function resumeOutcome(scope: ScopeReference, resume: BrowserEventResume) {
  if (resume.kind === 'accepted') {
    return create(SubscriptionOutcomeSchema, {
      scope,
      outcome: {
        case: 'accepted',
        value: { scope, acceptedCursor: resume.cursor },
      },
    });
  }
  return statusOutcome(
    scope,
    resume.kind === 'gap' ? StatusCode.GAP : StatusCode.SNAPSHOT_REQUIRED,
    resume.kind === 'gap'
      ? 'Requested event cursor is unavailable'
      : 'Authoritative snapshot required',
  );
}

export function setupBrowserV1Events(
  socket: Socket,
  principalUserId: string,
  retention: BrowserV1EventRetention = browserV1EventRetention,
): void {
  registerSocketRpc<Uint8Array, typeof browserCarrierPayloadSchema>(
    socket,
    BROWSER_V1_CARRIER_EVENTS.event,
    {
      payloadSchema: browserCarrierPayloadSchema,
      invalidPayloadResponse: encodeSocketIoStatus(
        create(StatusSchema, {
          code: StatusCode.MALFORMED_INPUT,
          message: 'Expected binary event subscription payload',
        }),
      ),
      handler: async (_ctx, acknowledge, payload) => {
        const decoded = decodeBrowserCarrier(payload, {
          expectedSchemaFingerprint: BROWSER_V1_SCHEMA_FINGERPRINT,
          allowedPayloads: ['event'],
        });
        if (!decoded.ok || decoded.envelope.payload.case !== 'event') {
          observeBrowserV1({
            event: 'decode',
            status: 'rejected',
            trafficClass: 'events',
            reason: decoded.ok ? 'wrong-envelope' : String(decoded.status.code),
          });
          acknowledge(
            encodeSocketIoStatus(
              decoded.ok
                ? create(StatusSchema, {
                    code: StatusCode.MALFORMED_INPUT,
                    message: 'Invalid event envelope',
                  })
                : decoded.status,
            ),
          );
          return;
        }
        const eventEnvelope = decoded.envelope.payload.value.payload;
        if (eventEnvelope.case !== 'subscribe' || !eventEnvelope.value.scope) {
          acknowledge(
            encodeEventPayload({
              case: 'subscriptionOutcome',
              value: statusOutcome(
                eventEnvelope.case === 'subscribe' && eventEnvelope.value.scope
                  ? eventEnvelope.value.scope
                  : { $typeName: 'browser.v1.ScopeReference', kind: ScopeKind.UNSPECIFIED, id: '' },
                StatusCode.MALFORMED_INPUT,
                'Expected subscription request',
              ),
            }),
          );
          return;
        }
        const request = eventEnvelope.value;
        if (!request.scope) return;
        const scope = request.scope;
        const state = socket.data.browserV1 as
          | { principalUserId?: string; assignments?: { events?: Representation } }
          | undefined;
        if (
          state?.principalUserId !== principalUserId ||
          state.assignments?.events !== Representation.BROWSER_V1
        ) {
          acknowledge(
            encodeEventPayload({
              case: 'subscriptionOutcome',
              value: statusOutcome(scope, StatusCode.INCOMPATIBLE, 'Binary events are not active'),
            }),
          );
          return;
        }

        let authorized = false;
        if (scope.kind === ScopeKind.USER) authorized = scope.id === principalUserId;
        if (scope.kind === ScopeKind.THREAD_STREAM || scope.kind === ScopeKind.THREAD_PRESENCE) {
          authorized = await canUserViewThread(scope.id, principalUserId);
          if (authorized) await openThreadForSocket(socket, principalUserId, scope.id);
        }
        if (!authorized) {
          acknowledge(
            encodeEventPayload({
              case: 'subscriptionOutcome',
              value: statusOutcome(
                scope,
                StatusCode.NOT_FOUND,
                'Subscription scope is unavailable',
              ),
            }),
          );
          return;
        }

        const resume = retention.resume(scope, request.cursor);
        observeBrowserV1({
          event: 'recovery',
          status: resume.kind === 'accepted' ? 'ok' : resume.kind,
          trafficClass: 'events',
        });
        acknowledge(
          encodeEventPayload({ case: 'subscriptionOutcome', value: resumeOutcome(scope, resume) }),
        );
        if (resume.kind === 'accepted') {
          for (const event of resume.events) {
            socket.emit(
              BROWSER_V1_CARRIER_EVENTS.event,
              encodeEventPayload({ case: 'event', value: event }),
            );
          }
        }
      },
    },
  );
}
