/**
 * Static-analysis tests — pin the runner-readiness contract.
 */
import { describe, test, expect } from 'bun:test';

import { readSocketioImplementationSources } from '../helpers/socketio-sources.js';

const source = readSocketioImplementationSources();

describe('socketio runner-readiness channel', () => {
  test('browser connect emits current runner:status to the new socket', () => {
    expect(source).toMatch(/socket\.emit\(\s*['"]runner:status['"]/);
    expect(source).toMatch(/presence\?\.userHasAvailableRunner\(userId\)/);
  });

  test('browser presentation does not import the concrete gRPC registry or relay presence', () => {
    expect(source).not.toMatch(/grpc\/session-registry/);
    expect(source).not.toMatch(/wsRelay\.userHasConnectedRunner/);
  });
});

describe('socketio pty:list RPC contract', () => {
  test('exposes a dedicated ack-based handler', () => {
    expect(source).toMatch(/function setupBrowserPtyListRpc/);
    expect(source).toMatch(/registerSocketRpc[\s\S]*?BROWSER_PTY_LIST_EVENT/);
  });

  test('responds with no-runner when the user has no connected runner', () => {
    const noRunnerHits = source.match(/status:\s*['"]no-runner['"]/g) ?? [];
    expect(noRunnerHits.length).toBeGreaterThanOrEqual(2);
  });

  test('lists sessions through the terminal port', () => {
    expect(source).toMatch(/terminals\.listSessions\(runnerId, userId\)/);
    expect(source).toMatch(/status:\s*['"]ok['"][\s\S]*?sessions/);
  });

  test('checks terminal availability before listing sessions', () => {
    expect(source).toMatch(/terminals\?\.isAvailable\(runnerId\)/);
  });

  test('produces an error response on internal failure', () => {
    expect(source).toMatch(/status:\s*['"]error['"]/);
  });

  test('keeps pty:list OUT of the fire-and-forget forwarder', () => {
    expect(source).toMatch(/BROWSER_PTY_FORWARD_EVENTS/);
    expect(source).not.toMatch(/BROWSER_PTY_FORWARD_EVENTS[\s\S]*'pty:list'/);
  });
});
