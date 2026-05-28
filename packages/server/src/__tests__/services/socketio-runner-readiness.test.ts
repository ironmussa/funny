/**
 * Static-analysis tests — pin the runner-readiness contract.
 */
import { describe, test, expect } from 'bun:test';

import { readSocketioImplementationSources } from '../helpers/socketio-sources.js';

const source = readSocketioImplementationSources();

describe('socketio runner-readiness channel', () => {
  test('browser connect emits current runner:status to the new socket', () => {
    expect(source).toMatch(/socket\.emit\(\s*['"]runner:status['"]/);
    expect(source).toMatch(/userHasConnectedRunner\(\s*userId\s*\)/);
  });

  test('runner connect emits runner:status: online to the user room', () => {
    expect(source).toMatch(
      /to\(\s*`user:\$\{runnerUserId\}`\s*\)\s*\.emit\(\s*['"]runner:status['"][\s\S]*?status:\s*['"]online['"]/,
    );
  });

  test('runner disconnect emits runner:status: offline gated on user index', () => {
    expect(source).toMatch(
      /!wsRelay\.userHasConnectedRunner\(\s*runnerUserId\s*\)[\s\S]*?status:\s*['"]offline['"]/,
    );
  });
});

describe('socketio pty:list RPC contract', () => {
  test('exposes a dedicated ack-based handler', () => {
    expect(source).toMatch(/function setupBrowserPtyListRpc/);
    expect(source).toMatch(/registerSocketRpc[\s\S]*?BROWSER_PTY_LIST_EVENT/);
  });

  test('responds with no-runner when the user has no connected runner', () => {
    const noRunnerHits = source.match(/status:\s*['"]no-runner['"]/g) ?? [];
    expect(noRunnerHits.length).toBeGreaterThanOrEqual(3);
  });

  test('forwards to runner with central:pty_list ack', () => {
    expect(source).toMatch(/emitWithAck\(\s*['"]central:pty_list['"]/);
    expect(source).toMatch(/status:\s*['"]ok['"][\s\S]*?sessions/);
  });

  test('produces a timeout response on runner ack timeout', () => {
    expect(source).toMatch(/runnerSocket[\s\S]*?\.timeout\(/);
    expect(source).toMatch(/status:\s*['"]timeout['"]/);
  });

  test('produces an error response on internal failure', () => {
    expect(source).toMatch(/status:\s*['"]error['"]/);
  });

  test('keeps pty:list OUT of the fire-and-forget forwarder', () => {
    expect(source).toMatch(/BROWSER_PTY_FORWARD_EVENTS/);
    expect(source).not.toMatch(/BROWSER_PTY_FORWARD_EVENTS[\s\S]*'pty:list'/);
  });
});
