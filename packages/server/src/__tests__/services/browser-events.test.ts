import { beforeEach, describe, expect, test } from 'bun:test';

import {
  broadcast,
  getConnectedBrowserUserIds,
  getRelayStats,
  relayToUser,
  setBrowserEventSink,
  setIO,
} from '../../services/browser-events.js';
import { browserV1ResourceStore } from '../../services/socketio/browser-v1-resource-store.js';
import { FakeBrowserEventSink } from '../helpers/runner-port-fakes.js';

describe('browser-events Socket.IO delivery', () => {
  const calls: Array<{ room: string; event: string }> = [];

  beforeEach(() => {
    calls.length = 0;
    const browser = {
      sockets: { size: 2 },
      adapter: {
        rooms: new Map([
          ['user:alice', new Set()],
          ['user:bob', new Set()],
        ]),
      },
      emit: (event: string) => calls.push({ room: '*', event }),
      to: (room: string) => ({ emit: (event: string) => calls.push({ room, event }) }),
    };
    setIO({ of: () => browser } as any);
  });

  test('continues delivering browser room events', () => {
    relayToUser('alice', { type: 'agent:status' });
    broadcast({ type: 'system:pulse' });
    expect(calls).toEqual([
      { room: 'user:alice', event: 'agent:status' },
      { room: '*', event: 'system:pulse' },
    ]);
    expect(getConnectedBrowserUserIds().sort()).toEqual(['alice', 'bob']);
  });

  test('reports browser connection counts without owning runner presence', () => {
    expect(getRelayStats()).toEqual({ browserClients: 2, browserUsers: 2 });
  });

  test('publishes terminal output as one typed interactive or legacy representation', () => {
    const sink = new FakeBrowserEventSink();
    setBrowserEventSink(sink);
    relayToUser('alice', {
      type: 'pty:data',
      threadId: '',
      data: { ptyId: 'pty-1', data: 'hello', sequence: 2n },
    });

    expect(sink.publications).toHaveLength(1);
    expect(sink.publications[0]).toMatchObject({
      scope: { kind: 'user', userId: 'alice' },
      trafficClass: 'terminal',
      browserV1Interactive: {
        payload: {
          case: 'terminal',
          value: {
            terminalId: 'pty-1',
            payload: { case: 'output', value: { sequence: 2n } },
          },
        },
      },
    });
  });

  test('serializes terminal output for legacy sockets without losing uint64 precision', () => {
    const wire: string[] = [];
    const socket = {
      data: {},
      emit: (type: string, event: unknown) => wire.push(JSON.stringify({ type, event })),
    };
    setIO({
      of: () => ({
        sockets: new Map([['socket-1', socket]]),
        adapter: { rooms: new Map([['user:alice', new Set(['socket-1'])]]) },
      }),
    } as any);

    const event = {
      type: 'pty:data',
      threadId: '',
      data: { ptyId: 'pty-1', data: '$ ', sequence: 9007199254740993n },
    };
    expect(() => relayToUser('alice', event)).not.toThrow();
    expect(wire).toEqual([
      JSON.stringify({
        type: 'pty:data',
        event: { ...event, data: { ...event.data, sequence: '9007199254740993' } },
      }),
    ]);

    const sink = new FakeBrowserEventSink();
    setBrowserEventSink(sink);
    relayToUser('alice', event);
    expect(sink.publications[0]?.browserV1Interactive).toMatchObject({
      payload: {
        case: 'terminal',
        value: { payload: { case: 'output', value: { sequence: 9007199254740993n } } },
      },
    });
    expect(event.data.sequence).toBe(9007199254740993n);
  });

  test('moves browser frames to bounded principal-scoped HTTP references', () => {
    const sink = new FakeBrowserEventSink();
    setBrowserEventSink(sink);
    relayToUser('alice', {
      type: 'browser-session:frame',
      threadId: '',
      data: { sessionId: 'browser-1', data: Buffer.from('jpeg').toString('base64') },
    });

    const publication = sink.publications[0];
    expect(publication).toMatchObject({
      trafficClass: 'browserSession',
      delivery: { class: 'coalescible', coalescingKey: 'browser-frame:browser-1' },
      browserV1Interactive: {
        payload: {
          case: 'browserSession',
          value: { payload: { case: 'frame', value: { sequence: 1n } } },
        },
      },
    });
    const interactive = publication?.browserV1Interactive;
    const frame =
      interactive?.payload.case === 'browserSession' &&
      interactive.payload.value.payload.case === 'frame'
        ? interactive.payload.value.payload.value.frame
        : undefined;
    const resourceId = frame?.resource?.id ?? '';
    expect(
      Buffer.from(browserV1ResourceStore.get(resourceId, 'alice')?.bytes ?? []).toString(),
    ).toBe('jpeg');
    expect(browserV1ResourceStore.get(resourceId, 'bob')).toBeUndefined();
  });

  test.each([
    [
      'ready',
      { url: 'https://a.test/', viewport: { width: 800, height: 600 }, controller: 'user' },
      'ready',
      'snapshot-recoverable',
      undefined,
      {
        targetUrl: 'https://a.test/',
        viewport: { width: 800, height: 600 },
        controller: 2,
        audioMuted: true,
      },
    ],
    [
      'viewport',
      { width: 1280, height: 720 },
      'viewport',
      'coalescible',
      'browser-viewport:s1',
      { width: 1280, height: 720 },
    ],
    [
      'navigated',
      { url: 'https://b.test/' },
      'navigated',
      'coalescible',
      'browser-navigated:s1',
      { url: 'https://b.test/' },
    ],
    [
      'controller',
      { controller: 'agent' },
      'controller',
      'coalescible',
      'browser-controller:s1',
      { controller: 1 },
    ],
    [
      'dialog',
      { dialog: { type: 'confirm', message: 'Delete?' } },
      'dialog',
      'snapshot-recoverable',
      undefined,
      { dialog: { type: 'confirm', message: 'Delete?' } },
    ],
    [
      'agent-opened',
      { threadId: 't1', url: 'https://c.test/' },
      'agentOpened',
      'snapshot-recoverable',
      undefined,
      { threadId: 't1', url: 'https://c.test/' },
    ],
    ['audio', { muted: false }, 'audio', 'coalescible', 'browser-audio:s1', { muted: false }],
    [
      'pointer',
      { x: 10.4, y: 20.6, kind: 'click' },
      'pointer',
      'volatile',
      undefined,
      { x: 10, y: 21, kind: 2 },
    ],
  ] as const)(
    'browser-session:%s is published as browser.v1 %s',
    (type, data, payloadCase, deliveryClass, coalescingKey, value) => {
      const sink = new FakeBrowserEventSink();
      setBrowserEventSink(sink);
      relayToUser('alice', {
        type: `browser-session:${type}`,
        threadId: '',
        data: { sessionId: 's1', ...data },
      });

      // One typed publication, no separate legacy toUser delivery.
      expect(sink.deliveries).toHaveLength(1);
      const publication = sink.publications[0];
      expect(publication).toMatchObject({
        trafficClass: 'browserSession',
        delivery: { class: deliveryClass, coalescingKey },
        browserV1Interactive: {
          payload: {
            case: 'browserSession',
            value: { browserSessionId: 's1', payload: { case: payloadCase, value } },
          },
        },
      });
    },
  );

  test('an unmapped browser-session event is dropped, not sent as a legacy event', () => {
    const sink = new FakeBrowserEventSink();
    setBrowserEventSink(sink);
    relayToUser('alice', {
      type: 'browser-session:unknown',
      threadId: '',
      data: { sessionId: 's1' },
    });
    expect(sink.publications).toEqual([]);
    expect(sink.deliveries).toEqual([]);
  });
});
