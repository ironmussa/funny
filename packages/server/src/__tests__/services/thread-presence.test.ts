/**
 * Unit tests for the thread presence handler (thread-sharing group 4).
 *
 * Drives setupThreadPresenceHandlers with a fake Socket and mocked access
 * checks to verify: the open gate, room joins (sharee → stream+presence, owner
 * → presence only), the PRESENCE_SYNC / PRESENCE_JOIN / PRESENCE_LEAVE
 * broadcasts, and disconnect cleanup.
 */

import { mock } from 'bun:test';

// Mutable fakes so each test can vary access/ownership.
let _canView = true;
let _isOwner = false;
mock.module('../../services/thread-access-check.js', () => ({
  canUserViewThread: async () => _canView,
  isThreadOwnedBy: async () => _isOwner,
  getUserDisplay: async () => ({ id: 'ana', name: 'Ana', image: 'https://img/ana.png' }),
}));

import { describe, test, expect, beforeEach } from 'bun:test';

import {
  PRESENCE_JOIN_EVENT,
  PRESENCE_LEAVE_EVENT,
  PRESENCE_SYNC_EVENT,
  THREAD_CLOSE_EVENT,
  THREAD_OPEN_EVENT,
} from '@funny/shared/socket-events';

import {
  __resetPresenceForTests,
  setupThreadPresenceHandlers,
} from '../../services/socketio/thread-presence.js';

function makeSocket(id: string) {
  const handlers: Record<string, (raw: unknown) => unknown> = {};
  const joined = new Set<string>();
  const left: string[] = [];
  const emitted: Array<{ event: string; payload: any }> = [];
  const toEmitted: Array<{ room: string; event: string; payload: any }> = [];
  const socket: any = {
    id,
    data: {},
    on: (e: string, h: (raw: unknown) => unknown) => {
      handlers[e] = h;
    },
    join: (r: string) => joined.add(r),
    leave: (r: string) => left.push(r),
    emit: (e: string, p: any) => emitted.push({ event: e, payload: p }),
    to: (room: string) => ({
      emit: (e: string, p: any) => toEmitted.push({ room, event: e, payload: p }),
    }),
  };
  return { socket, handlers, joined, left, emitted, toEmitted };
}

const PRESENCE = 'thread:t1:presence';
const STREAM = 'thread:t1:stream';

describe('thread presence handler', () => {
  beforeEach(() => {
    _canView = true;
    _isOwner = false;
    __resetPresenceForTests();
  });

  test('sharee open: joins presence + stream rooms, gets sync, announces join', async () => {
    const f = makeSocket('s1');
    setupThreadPresenceHandlers(f.socket, 'ana');

    await f.handlers[THREAD_OPEN_EVENT]({ threadId: 't1' });

    expect(f.joined.has(PRESENCE)).toBe(true);
    expect(f.joined.has(STREAM)).toBe(true);

    const sync = f.emitted.find((e) => e.event === PRESENCE_SYNC_EVENT);
    expect(sync).toBeTruthy();
    expect(sync!.payload.viewers).toEqual([]); // empty roster before self is added

    const join = f.toEmitted.find((e) => e.event === PRESENCE_JOIN_EVENT);
    expect(join).toMatchObject({
      room: PRESENCE,
      payload: { threadId: 't1', viewer: { clientId: 's1', user: { id: 'ana', name: 'Ana' } } },
    });
  });

  test('owner open: joins presence room ONLY (not the stream room)', async () => {
    _isOwner = true;
    const f = makeSocket('s2');
    setupThreadPresenceHandlers(f.socket, 'owner-1');

    await f.handlers[THREAD_OPEN_EVENT]({ threadId: 't1' });

    expect(f.joined.has(PRESENCE)).toBe(true);
    expect(f.joined.has(STREAM)).toBe(false);
  });

  test('denied open (no view access): no joins, no broadcasts', async () => {
    _canView = false;
    const f = makeSocket('s3');
    setupThreadPresenceHandlers(f.socket, 'bob-3');

    await f.handlers[THREAD_OPEN_EVENT]({ threadId: 't1' });

    expect(f.joined.size).toBe(0);
    expect(f.emitted).toHaveLength(0);
    expect(f.toEmitted).toHaveLength(0);
  });

  test('close: leaves rooms and announces leave', async () => {
    const f = makeSocket('s4');
    setupThreadPresenceHandlers(f.socket, 'ana');
    await f.handlers[THREAD_OPEN_EVENT]({ threadId: 't1' });

    f.handlers[THREAD_CLOSE_EVENT]({ threadId: 't1' });

    expect(f.left).toContain(PRESENCE);
    expect(f.left).toContain(STREAM);
    const leave = f.toEmitted.find((e) => e.event === PRESENCE_LEAVE_EVENT);
    expect(leave).toMatchObject({ room: PRESENCE, payload: { threadId: 't1', clientId: 's4' } });
  });

  test('disconnect: leaves every open thread', async () => {
    const f = makeSocket('s5');
    setupThreadPresenceHandlers(f.socket, 'ana');
    await f.handlers[THREAD_OPEN_EVENT]({ threadId: 't1' });

    f.handlers.disconnect(undefined);

    expect(f.left).toContain(PRESENCE);
    const leave = f.toEmitted.find((e) => e.event === PRESENCE_LEAVE_EVENT);
    expect(leave).toBeTruthy();
  });

  test('second viewer receives the first in its sync roster', async () => {
    const a = makeSocket('s-a');
    setupThreadPresenceHandlers(a.socket, 'ana');
    await a.handlers[THREAD_OPEN_EVENT]({ threadId: 't1' });

    const b = makeSocket('s-b');
    setupThreadPresenceHandlers(b.socket, 'ana');
    await b.handlers[THREAD_OPEN_EVENT]({ threadId: 't1' });

    const syncB = b.emitted.find((e) => e.event === PRESENCE_SYNC_EVENT);
    expect(syncB!.payload.viewers.map((v: any) => v.clientId)).toEqual(['s-a']);
  });
});
