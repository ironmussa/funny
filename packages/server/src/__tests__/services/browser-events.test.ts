import { beforeEach, describe, expect, test } from 'bun:test';

import {
  broadcast,
  getConnectedBrowserUserIds,
  getRelayStats,
  relayToUser,
  setIO,
} from '../../services/browser-events.js';

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
});
