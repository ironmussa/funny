import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import {
  BrowserSessionController,
  BrowserSessionMessageSchema,
  BrowserSessionPointerKind,
  type BrowserSessionMessage,
} from '@funny/shared/browser-v1/interactive';
import { describe, expect, test } from 'vitest';

import { browserSessionEventFromV1 } from './browser-session-v1-events';

/** Encode and decode, so the test sees what actually crosses the wire. */
function wire(payload: BrowserSessionMessage['payload']): BrowserSessionMessage {
  const message = create(BrowserSessionMessageSchema, { browserSessionId: 's1', payload });
  return fromBinary(BrowserSessionMessageSchema, toBinary(BrowserSessionMessageSchema, message));
}

describe('browserSessionEventFromV1', () => {
  test.each([
    [
      'ready with viewport and controller',
      {
        case: 'ready',
        value: {
          targetUrl: 'https://a.test/',
          viewport: { width: 800, height: 600 },
          controller: BrowserSessionController.USER,
        },
      },
      {
        type: 'browser-session:ready',
        data: {
          sessionId: 's1',
          url: 'https://a.test/',
          viewport: { width: 800, height: 600 },
          controller: 'user',
          audioMuted: false,
        },
      },
    ],
    [
      'audio',
      { case: 'audio', value: { muted: false } },
      { type: 'browser-session:audio', data: { sessionId: 's1', muted: false } },
    ],
    [
      'viewport',
      { case: 'viewport', value: { width: 1280, height: 720 } },
      { type: 'browser-session:viewport', data: { sessionId: 's1', width: 1280, height: 720 } },
    ],
    [
      'navigated',
      { case: 'navigated', value: { url: 'https://b.test/' } },
      { type: 'browser-session:navigated', data: { sessionId: 's1', url: 'https://b.test/' } },
    ],
    [
      'controller',
      { case: 'controller', value: { controller: BrowserSessionController.AGENT } },
      { type: 'browser-session:controller', data: { sessionId: 's1', controller: 'agent' } },
    ],
    [
      'pending dialog',
      {
        case: 'dialog',
        value: { dialog: { type: 'prompt', message: 'Name?', defaultValue: 'x' } },
      },
      {
        type: 'browser-session:dialog',
        data: { sessionId: 's1', dialog: { type: 'prompt', message: 'Name?', defaultValue: 'x' } },
      },
    ],
    [
      'answered dialog',
      { case: 'dialog', value: {} },
      { type: 'browser-session:dialog', data: { sessionId: 's1', dialog: null } },
    ],
    [
      'agent opened',
      { case: 'agentOpened', value: { threadId: 't1', url: 'https://c.test/' } },
      {
        type: 'browser-session:agent-opened',
        data: { sessionId: 's1', threadId: 't1', url: 'https://c.test/' },
      },
    ],
    [
      'pointer',
      { case: 'pointer', value: { x: 10, y: 20, kind: BrowserSessionPointerKind.CLICK } },
      { type: 'browser-session:pointer', data: { sessionId: 's1', x: 10, y: 20, kind: 'click' } },
    ],
    [
      'close',
      { case: 'close', value: { reason: 'idle' } },
      { type: 'browser-session:closed', data: { sessionId: 's1', reason: 'idle' } },
    ],
  ] as const)('%s', (_name, payload, expected) => {
    expect(browserSessionEventFromV1(wire(payload as BrowserSessionMessage['payload']))).toEqual(
      expected,
    );
  });

  test('a pointer without a kind is ignored', () => {
    expect(
      browserSessionEventFromV1(wire({ case: 'pointer', value: { x: 1, y: 2 } } as never)),
    ).toBeNull();
  });

  test('client → server requests are not panel events', () => {
    expect(
      browserSessionEventFromV1(wire({ case: 'navigate', value: { targetUrl: 'x' } } as never)),
    ).toBeNull();
  });
});
