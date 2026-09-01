/**
 * Shared deterministic collaborators for proxy middleware tests.
 */

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

export function createRunnerResolverMock() {
  return {
    resolveRunner: async () => ({ runnerId: 'runner-1', httpUrl: null }),
    resolveAnyRunner: async () => ({ runnerId: 'runner-1', httpUrl: null }),
  };
}
