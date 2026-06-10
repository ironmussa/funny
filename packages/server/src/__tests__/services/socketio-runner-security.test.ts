/**
 * Static-analysis tests for runner-namespace security wiring.
 */
import { describe, test, expect } from 'bun:test';

import { readSocketioImplementationSources } from '../helpers/socketio-sources.js';

const source = readSocketioImplementationSources();

describe('socketio runner namespace security', () => {
  test('requires bearer token during /runner handshake', () => {
    expect(source).toMatch(/if\s*\(\s*!token\s*\)/);
    expect(source).toMatch(/authenticateRunner\(token\)/);
  });

  test('times out hung runner auth lookups', () => {
    expect(source).toMatch(/Authentication timed out/);
    expect(source).toMatch(/Promise\.race\(/);
  });

  test('gates runner:agent_event and runner:browser_relay on allowRunnerEvent', () => {
    expect(source).toMatch(/RUNNER_AGENT_EVENT[\s\S]*?allowRunnerEvent\(\s*RUNNER_AGENT_EVENT/);
    expect(source).toMatch(/RUNNER_BROWSER_RELAY[\s\S]*?allowRunnerEvent\(\s*RUNNER_BROWSER_RELAY/);
  });

  test('validates project ownership before runner:assign_project', () => {
    expect(source).toMatch(/runner:assign_project[\s\S]*?resolveProjectPath\(/);
    expect(source).toMatch(/authz\.cross_tenant_refused[\s\S]*?runner_assign_project/);
  });

  test('forwards data events with runnerUserId into data-handler', () => {
    expect(source).toMatch(/handleDataMessageWithAck\(runnerId,\s*runnerUserId/);
  });

  test('rejects duplicate in-flight data requestIds', () => {
    expect(source).toMatch(/Duplicate in-flight requestId/);
    expect(source).toMatch(/inFlightRequestIds\.has\(requestId\)/);
  });

  test('rate-limits runner agent events', () => {
    expect(source).toMatch(
      /RUNNER_AGENT_EVENT[\s\S]*?isRateLimited\(ctx\.socket\.id,\s*500,\s*10_000\)/,
    );
  });

  test('gates threadId side effects on thread ownership before status/event writes', () => {
    // The relay check validates msg.userId, not the nested event.threadId.
    // updateThreadStatus / terminal+orchestrator publishes must be gated on
    // threadBelongsToUser(threadId, runnerUserId) so a runner cannot mutate
    // another tenant's thread.
    expect(source).toMatch(/threadBelongsToUser\(\s*threadId\s*,\s*ctx\.runnerUserId\s*\)/);
    expect(source).toMatch(
      /threadBelongsToUser[\s\S]*?if\s*\(\s*!owned\s*\)[\s\S]*?authz\.cross_tenant_refused/,
    );
  });
});
