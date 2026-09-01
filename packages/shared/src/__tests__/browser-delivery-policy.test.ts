import { describe, expect, test } from 'bun:test';

import { create } from '@bufbuild/protobuf';

import {
  applicationEventDeliveryPolicy,
  interactiveDeliveryPolicy,
} from '../browser-delivery-policy.js';
import { DeliveryClass } from '../generated/browser-v1/browser/v1/common_pb.js';
import { ApplicationEventSchema } from '../generated/browser-v1/browser/v1/events_pb.js';
import { InteractiveEnvelopeSchema } from '../generated/browser-v1/browser/v1/interactive_pb.js';

describe('browser.v1 delivery policy', () => {
  test('declares recovery for every migrated application event family', () => {
    const cases = [
      ['user', 'snapshot'],
      ['threadStream', 'cursor'],
      ['threadPresence', 'snapshot'],
      ['runnerState', 'snapshot'],
    ] as const;
    for (const [payloadCase, replay] of cases) {
      const event = create(ApplicationEventSchema, {
        payload: { case: payloadCase, value: {} },
      });
      expect(applicationEventDeliveryPolicy(event).replay).toBe(replay);
    }
  });

  test('never replays at-most-once input and reserves completion priority', () => {
    const terminalWrite = create(InteractiveEnvelopeSchema, {
      payload: {
        case: 'terminal',
        value: { terminalId: 'pty-1', payload: { case: 'write', value: {} } },
      },
    });
    const terminalExit = create(InteractiveEnvelopeSchema, {
      payload: {
        case: 'terminal',
        value: { terminalId: 'pty-1', payload: { case: 'exit', value: {} } },
      },
    });
    const browserFrame = create(InteractiveEnvelopeSchema, {
      payload: {
        case: 'browserSession',
        value: { browserSessionId: 'browser-1', payload: { case: 'frame', value: {} } },
      },
    });
    expect(interactiveDeliveryPolicy(terminalWrite)).toMatchObject({
      deliveryClass: DeliveryClass.AT_MOST_ONCE,
      replay: 'never',
      droppable: false,
    });
    expect(interactiveDeliveryPolicy(terminalExit).priority).toBe('control');
    expect(interactiveDeliveryPolicy(browserFrame)).toMatchObject({
      deliveryClass: DeliveryClass.COALESCIBLE,
      replay: 'latest',
      droppable: true,
    });
  });
});
