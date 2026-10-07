/**
 * Shared deterministic collaborators for proxy middleware tests.
 */

import type { RunnerAccess } from '../../services/runner-access/index.js';
import { fakeRunnerAccess } from './runner-access-fakes.js';

export class MockTunnelTimeoutError extends Error {
  readonly runnerId: string;
  readonly timeoutMs: number;

  constructor(runnerId: string, timeoutMs: number) {
    super(`Tunnel to runner ${runnerId} timed out after ${timeoutMs}ms`);
    this.name = 'TunnelTimeoutError';
    this.runnerId = runnerId;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Runner access that always certifies `runner-1` for `user-1` (the proxy
 * tests' default identity) and for the identity-free OAuth callback.
 */
export function createRunnerAccessMock(
  opts: { runnerId?: string; ownerId?: string; onSelect?: (userId: string) => void } = {},
): RunnerAccess {
  const runnerId = opts.runnerId ?? 'runner-1';
  return fakeRunnerAccess({
    runnerFor: () => runnerId,
    owners: { [runnerId]: opts.ownerId ?? 'user-1' },
    oauthRunner: runnerId,
    onSelect: (userId) => opts.onSelect?.(userId),
  });
}
