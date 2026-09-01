import { describe, expect, test } from 'bun:test';

import {
  RunnerGrpcSessionRegistry,
  type RunnerGrpcSessionConnection,
  type RunnerGrpcSessionEndReason,
} from '../../services/grpc/session-registry.js';

function connection(reasons: string[]): RunnerGrpcSessionConnection {
  return {
    invalidate: (reason) => reasons.push(reason),
  };
}

describe('RunnerGrpcSessionRegistry', () => {
  test('atomically replaces a session without stale cleanup marking the runner unavailable', async () => {
    const firstInvalidations: string[] = [];
    const secondInvalidations: string[] = [];
    const unavailable: Array<{ epoch: bigint; reason: RunnerGrpcSessionEndReason }> = [];
    const registry = new RunnerGrpcSessionRegistry({
      heartbeatTimeoutMs: 10_000,
      onUnavailable: (_runnerId, epoch, reason) => {
        unavailable.push({ epoch, reason });
      },
    });

    const firstEpoch = registry.activate('runner-1', connection(firstInvalidations));
    const secondEpoch = registry.activate('runner-1', connection(secondInvalidations));

    expect(firstEpoch).toBe(1n);
    expect(secondEpoch).toBe(2n);
    expect(firstInvalidations).toEqual(['session-replaced']);
    expect(secondInvalidations).toEqual([]);
    expect(registry.activeEpoch('runner-1')).toBe(secondEpoch);
    expect(registry.deactivate('runner-1', firstEpoch)).toBe(false);
    await registry.whenIdle('runner-1');
    expect(unavailable).toEqual([]);

    expect(registry.deactivate('runner-1', secondEpoch)).toBe(true);
    await registry.whenIdle('runner-1');
    expect(unavailable).toEqual([{ epoch: 2n, reason: 'session-closed' }]);
  });

  test('rejects heartbeats from superseded epochs', () => {
    const registry = new RunnerGrpcSessionRegistry({ heartbeatTimeoutMs: 10_000 });
    const firstEpoch = registry.activate('runner-1', connection([]));
    const secondEpoch = registry.activate('runner-1', connection([]));

    expect(registry.heartbeat('runner-1', firstEpoch)).toBe(false);
    expect(registry.heartbeat('runner-1', secondEpoch)).toBe(true);
    registry.closeAll();
  });

  test('is the authoritative runner and user presence index', () => {
    const registry = new RunnerGrpcSessionRegistry({ heartbeatTimeoutMs: 10_000 });
    const firstEpoch = registry.activate('runner-1', connection([]), 'user-1');
    const secondEpoch = registry.activate('runner-2', connection([]), 'user-1');

    expect(registry.isAvailable('runner-1')).toBe(true);
    expect(registry.userIdForRunner('runner-1')).toBe('user-1');
    expect(registry.userHasAvailableRunner('user-1')).toBe(true);
    expect(registry.availableRunnerCount()).toBe(2);

    registry.deactivate('runner-1', firstEpoch);
    expect(registry.userHasAvailableRunner('user-1')).toBe(true);
    registry.activate('runner-2', connection([]), 'user-2');
    expect(registry.userHasAvailableRunner('user-1')).toBe(false);
    expect(registry.userHasAvailableRunner('user-2')).toBe(true);
    expect(registry.deactivate('runner-2', secondEpoch)).toBe(false);
    registry.closeAll();
  });

  test('expires a silent active session and marks only its epoch unavailable', async () => {
    const invalidations: string[] = [];
    const unavailable: Array<{ epoch: bigint; reason: RunnerGrpcSessionEndReason }> = [];
    const registry = new RunnerGrpcSessionRegistry({
      heartbeatTimeoutMs: 10,
      onUnavailable: (_runnerId, epoch, reason) => {
        unavailable.push({ epoch, reason });
      },
    });
    const epoch = registry.activate('runner-1', connection(invalidations));

    await new Promise((resolve) => setTimeout(resolve, 20));
    await registry.whenIdle('runner-1');

    expect(registry.activeEpoch('runner-1')).toBeNull();
    expect(invalidations).toEqual(['heartbeat-expired']);
    expect(unavailable).toEqual([{ epoch, reason: 'heartbeat-expired' }]);
  });
});
