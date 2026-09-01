import { describe, expect, test } from 'bun:test';

import {
  FakeBrowserEventSink,
  FakeRunnerPresencePort,
  FakeRunnerRequestPort,
  FakeRunnerTerminalPort,
} from '../helpers/runner-port-fakes.js';

describe('runner capability port contracts', () => {
  test('request ports expose readiness and preserve request/response bytes', async () => {
    const port = new FakeRunnerRequestPort();
    expect(port.isAvailable('runner-1')).toBe(false);
    port.available.add('runner-1');
    port.response = {
      status: 201,
      headers: { 'content-type': 'application/octet-stream' },
      body: 'AAEC',
      bodyEncoding: 'base64',
    };
    await expect(
      port.request('runner-1', {
        method: 'POST',
        path: '/binary',
        headers: {},
        body: new Uint8Array([0, 1, 2]),
      }),
    ).resolves.toEqual(port.response);
    expect(port.requests[0]?.request.body).toEqual(new Uint8Array([0, 1, 2]));
  });

  test('terminal ports scope dispatch and session lists by runner and user', () => {
    const port = new FakeRunnerTerminalPort();
    port.available.add('runner-1');
    port.sessions.set('runner-1\0user-1', [{ ptyId: 'pty-1' }]);
    port.dispatch('runner-1', 'user-1', {
      type: 'pty:write',
      data: { id: 'pty-1', data: 'pwd\n' },
    });
    expect(port.events).toHaveLength(1);
    expect(port.listSessions('runner-1', 'user-1')).toEqual([{ ptyId: 'pty-1' }]);
    expect(port.listSessions('runner-1', 'user-2')).toEqual([]);
  });

  test('presence ports derive user readiness from active runner ownership', () => {
    const port = new FakeRunnerPresencePort();
    port.owners.set('runner-1', 'user-1');
    expect(port.isAvailable('runner-1')).toBe(true);
    expect(port.userIdForRunner('runner-1')).toBe('user-1');
    expect(port.userHasAvailableRunner('user-1')).toBe(true);
    expect(port.userHasAvailableRunner('user-2')).toBe(false);
  });

  test('browser sinks keep each audience explicit', () => {
    const sink = new FakeBrowserEventSink();
    const event = { type: 'agent:result' };
    sink.toUser('user-1', event);
    sink.toThreadStream('thread-1', event);
    sink.toThreadPresence('thread-1', event);
    sink.toThreadViewers('thread-1', event);
    sink.toAll(event);
    sink.evictFromThread('user-1', 'thread-1');
    expect(sink.deliveries.map(({ target }) => target)).toEqual([
      'user',
      'thread-stream',
      'thread-presence',
      'thread-viewers',
      'all',
      'evict',
    ]);
  });
});
