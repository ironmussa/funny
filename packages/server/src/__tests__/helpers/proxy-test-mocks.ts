/**
 * Shared WS tunnel mocks for proxy middleware tests.
 *
 * Uses a standalone TunnelTimeoutError class so instanceof checks remain
 * stable even when Bun's mock.module replaces ws-tunnel with a stub.
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

export function createWsTunnelMock(options: {
  isRunnerConnected?: () => boolean;
  tunnelFetch?: (runnerId: string) => Promise<never>;
}) {
  return {
    setIO: () => {},
    TunnelTimeoutError: MockTunnelTimeoutError,
    tunnelFetch:
      options.tunnelFetch ??
      (async () => {
        throw new Error('socket not found');
      }),
  };
}

export function createWsRelayMock(isRunnerConnected: () => boolean) {
  return {
    setIO: () => {},
    isRunnerConnected,
  };
}

export function createRunnerResolverMock() {
  return {
    resolveRunner: async () => ({ runnerId: 'runner-1', httpUrl: 'http://runner.local' }),
    resolveAnyRunner: async () => ({ runnerId: 'runner-1', httpUrl: 'http://runner.local' }),
  };
}
