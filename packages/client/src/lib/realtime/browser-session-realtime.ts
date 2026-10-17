import { create, type JsonObject } from '@bufbuild/protobuf';
import type { ClientRealtimePort } from '@funny/client-core';
import {
  DeliveryClass,
  DeliveryMetadataSchema,
  RequestMetadataSchema,
} from '@funny/shared/browser-v1/common';
import { InteractiveEnvelopeSchema } from '@funny/shared/browser-v1/interactive';

interface BrowserSessionTransport extends Pick<ClientRealtimePort, 'sendInteractive'> {
  connected(): boolean;
}

let transport: BrowserSessionTransport | null = null;
const browserInputOrdinals = new Map<string, bigint>();
const browserHeartbeatOrdinals = new Map<string, bigint>();

/** The connection owner installs and clears the transport during its lifecycle. */
export function setBrowserSessionTransport(next: BrowserSessionTransport | null): void {
  transport = next;
}

type BrowserSessionRealtimeCommand =
  | { case: 'open'; targetUrl: string; projectId?: string }
  | { case: 'navigate'; targetUrl: string }
  | { case: 'input'; action: JsonObject }
  | { case: 'inspect'; selector: JsonObject; requestId: string }
  | { case: 'execute'; expression: string; requestId: string }
  | { case: 'historyNavigation'; action: string; requestId: string }
  | { case: 'screenshot'; requestId: string }
  | { case: 'heartbeat' }
  | { case: 'close'; reason?: string };

/** Send browser-session commands through their independently negotiated traffic class. */
export function sendBrowserSessionRealtime(
  browserSessionId: string,
  command: BrowserSessionRealtimeCommand,
): boolean {
  if (!transport || !transport.connected()) return false;
  let deliveryClass: DeliveryClass;
  let payload: any;
  let requestId: string | undefined;
  switch (command.case) {
    case 'open':
      deliveryClass = DeliveryClass.SNAPSHOT_RECOVERABLE;
      payload = {
        case: 'open',
        value: { targetUrl: command.targetUrl, projectId: command.projectId },
      };
      break;
    case 'navigate':
      deliveryClass = DeliveryClass.COALESCIBLE;
      payload = { case: 'navigate', value: { targetUrl: command.targetUrl } };
      break;
    case 'input': {
      deliveryClass = DeliveryClass.AT_MOST_ONCE;
      const ordinal = (browserInputOrdinals.get(browserSessionId) ?? 0n) + 1n;
      browserInputOrdinals.set(browserSessionId, ordinal);
      payload = { case: 'input', value: { inputOrdinal: ordinal, action: command.action } };
      break;
    }
    case 'inspect':
      deliveryClass = DeliveryClass.SNAPSHOT_RECOVERABLE;
      requestId = command.requestId;
      payload = { case: 'inspect', value: { selector: command.selector } };
      break;
    case 'execute':
      deliveryClass = DeliveryClass.AT_MOST_ONCE;
      requestId = command.requestId;
      payload = { case: 'execute', value: { expression: command.expression } };
      break;
    case 'historyNavigation':
      deliveryClass = DeliveryClass.AT_MOST_ONCE;
      requestId = command.requestId;
      payload = { case: 'historyNavigation', value: { action: command.action } };
      break;
    case 'screenshot':
      deliveryClass = DeliveryClass.AT_MOST_ONCE;
      requestId = command.requestId;
      payload = { case: 'screenshot', value: {} };
      break;
    case 'heartbeat': {
      deliveryClass = DeliveryClass.VOLATILE;
      const ordinal = (browserHeartbeatOrdinals.get(browserSessionId) ?? 0n) + 1n;
      browserHeartbeatOrdinals.set(browserSessionId, ordinal);
      payload = { case: 'heartbeat', value: { ordinal } };
      break;
    }
    case 'close':
      deliveryClass = DeliveryClass.SNAPSHOT_RECOVERABLE;
      payload = { case: 'close', value: { reason: command.reason ?? 'user' } };
      break;
  }
  transport.sendInteractive(
    create(InteractiveEnvelopeSchema, {
      metadata: requestId ? create(RequestMetadataSchema, { requestId }) : undefined,
      delivery: create(DeliveryMetadataSchema, { deliveryClass }),
      payload: { case: 'browserSession', value: { browserSessionId, payload } },
    }),
  );
  return true;
}
