/**
 * withRoutedTerminalSessions: sessions on the runners of a user's other
 * terminal routes (e.g. a sandbox thread's) are merged into a listing — but
 * only from a runner whose terminal channel is available. `isAvailable` is
 * async: used as a bare condition it would always be truthy.
 */
import { describe, expect, test } from 'bun:test';

import { withRoutedTerminalSessions } from '../../services/socketio/terminal-list.js';
import { terminalRoute } from '../../services/socketio/terminal-targets.js';
import { fakeRunnerAccess } from '../helpers/runner-access-fakes.js';
import { FakeRunnerTerminalPort } from '../helpers/runner-port-fakes.js';

const USER = 'user-terminal-list';
const SANDBOX_RUNNER = 'sandbox-runner';

function setup() {
  terminalRoute(USER, {
    type: 'pty:spawn',
    id: 'pty-sandbox',
    sandboxThreadId: 'th-1',
  }).dispatched();
  const terminals = new FakeRunnerTerminalPort();
  terminals.sessions.set(`${SANDBOX_RUNNER}\0${USER}`, [{ ptyId: 'pty-sandbox' }]);
  const access = fakeRunnerAccess({
    runnerFor: () => SANDBOX_RUNNER,
    owners: { [SANDBOX_RUNNER]: USER },
  });
  return { terminals, access };
}

describe('withRoutedTerminalSessions', () => {
  test('adds the sessions of an available routed runner', async () => {
    const { terminals, access } = setup();
    terminals.available.add(SANDBOX_RUNNER);
    const merged = await withRoutedTerminalSessions([{ ptyId: 'pty-local' }], USER, {
      access,
      terminals,
    });
    expect(merged.map((s) => s.ptyId)).toEqual(['pty-local', 'pty-sandbox']);
  });

  test('adds nothing from a routed runner whose terminal channel is unavailable', async () => {
    const { terminals, access } = setup();
    const merged = await withRoutedTerminalSessions([{ ptyId: 'pty-local' }], USER, {
      access,
      terminals,
    });
    expect(merged.map((s) => s.ptyId)).toEqual(['pty-local']);
  });
});
