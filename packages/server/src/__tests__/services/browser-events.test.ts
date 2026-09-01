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
});
