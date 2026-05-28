/**
 * Verifies that all required PTY forward events are registered via shared contract.
 */

import { describe, test, expect } from 'bun:test';

import { BROWSER_PTY_FORWARD_EVENTS } from '@funny/shared/socket-events';

/**
 * PTY events the runtime handles in central:browser_ws.
 * Note: `pty:list` is ack-based RPC — not in this list.
 */
const REQUIRED_PTY_EVENTS = [
  'pty:spawn',
  'pty:write',
  'pty:resize',
  'pty:close',
  'pty:kill',
  'pty:rename',
  'pty:reconnect',
  'pty:restore',
];

describe('socketio PTY event forwarding', () => {
  test('shared contract lists every runtime PTY forward event', () => {
    const missing = REQUIRED_PTY_EVENTS.filter(
      (event) =>
        !BROWSER_PTY_FORWARD_EVENTS.includes(event as (typeof BROWSER_PTY_FORWARD_EVENTS)[number]),
    );
    expect(missing).toEqual([]);
  });

  test('pty:list is not in the fire-and-forget forwarder list', () => {
    expect(BROWSER_PTY_FORWARD_EVENTS).not.toContain('pty:list');
  });
});
