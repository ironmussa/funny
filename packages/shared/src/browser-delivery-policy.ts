import { DeliveryClass } from './generated/browser-v1/browser/v1/common_pb.js';
import type { ApplicationEvent } from './generated/browser-v1/browser/v1/events_pb.js';
import type { InteractiveEnvelope } from './generated/browser-v1/browser/v1/interactive_pb.js';

export interface BrowserDeliveryPolicy {
  deliveryClass: DeliveryClass;
  replay: 'cursor' | 'snapshot' | 'latest' | 'never';
  droppable: boolean;
  priority: 'control' | 'normal' | 'bulk';
}

const POLICIES = {
  durable: {
    deliveryClass: DeliveryClass.DURABLE,
    replay: 'cursor',
    droppable: false,
    priority: 'normal',
  },
  snapshot: {
    deliveryClass: DeliveryClass.SNAPSHOT_RECOVERABLE,
    replay: 'snapshot',
    droppable: false,
    priority: 'normal',
  },
  coalescible: {
    deliveryClass: DeliveryClass.COALESCIBLE,
    replay: 'latest',
    droppable: true,
    priority: 'bulk',
  },
  volatile: {
    deliveryClass: DeliveryClass.VOLATILE,
    replay: 'never',
    droppable: true,
    priority: 'bulk',
  },
  atMostOnce: {
    deliveryClass: DeliveryClass.AT_MOST_ONCE,
    replay: 'never',
    droppable: false,
    priority: 'normal',
  },
} as const satisfies Record<string, BrowserDeliveryPolicy>;

export function applicationEventDeliveryPolicy(event: ApplicationEvent): BrowserDeliveryPolicy {
  if (event.payload.case === 'threadStream') return POLICIES.durable;
  return POLICIES.snapshot;
}

export function interactiveDeliveryPolicy(message: InteractiveEnvelope): BrowserDeliveryPolicy {
  if (message.payload.case === 'terminal') {
    switch (message.payload.value.payload.case) {
      case 'write':
      case 'signal':
        return POLICIES.atMostOnce;
      case 'resize':
      case 'rename':
        return POLICIES.coalescible;
      case 'output':
        return POLICIES.durable;
      case 'exit':
      case 'error':
      case 'close':
        return { ...POLICIES.durable, priority: 'control' };
      case 'reconnect':
      case 'restore':
      case 'spawn':
        return POLICIES.snapshot;
      default:
        return POLICIES.volatile;
    }
  }
  if (message.payload.case === 'browserSession') {
    switch (message.payload.value.payload.case) {
      case 'input':
      case 'execute':
        return POLICIES.atMostOnce;
      case 'frame':
      case 'navigate':
        return POLICIES.coalescible;
      case 'console':
        return POLICIES.volatile;
      case 'heartbeat':
        return POLICIES.volatile;
      case 'historyNavigation':
      case 'screenshot':
        return POLICIES.atMostOnce;
      case 'close':
      case 'status':
        return { ...POLICIES.snapshot, priority: 'control' };
      case 'open':
      case 'inspect':
      case 'result':
      case 'ready':
        return POLICIES.snapshot;
      default:
        return POLICIES.volatile;
    }
  }
  return POLICIES.volatile;
}

export function hasValidDeclaredDeliveryClass(
  message: ApplicationEvent | InteractiveEnvelope,
): boolean {
  const expected =
    message.$typeName === 'browser.v1.ApplicationEvent'
      ? applicationEventDeliveryPolicy(message as ApplicationEvent)
      : interactiveDeliveryPolicy(message as InteractiveEnvelope);
  return message.delivery?.deliveryClass === expected.deliveryClass;
}
