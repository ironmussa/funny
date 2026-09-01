import { describe, expect, test, vi } from 'vitest';

import {
  RunnerConnectionSupervisor,
  requireRunnerGrpcEndpoint,
  type SupervisedRunnerTransport,
} from '../../services/runner-connection-supervisor.js';

function options() {
  return {
    token: 'token',
    runner: {
      instanceId: 'runner-1',
      name: 'Runner',
      hostname: 'host',
      operatingSystem: 'linux',
      workspace: '/repo',
      activeProviderIds: [],
    },
  };
}

describe('RunnerConnectionSupervisor', () => {
  test('validates the configured endpoint', () => {
    expect(requireRunnerGrpcEndpoint({ RUNNER_GRPC_ENDPOINT: ' grpc.test:443 ' })).toBe(
      'grpc.test:443',
    );
    expect(() => requireRunnerGrpcEndpoint({})).toThrow('RUNNER_GRPC_ENDPOINT is required');
  });

  test('replaces an active transport and owns shutdown', () => {
    const transports: Array<
      SupervisedRunnerTransport & {
        start: ReturnType<typeof vi.fn>;
        shutdown: ReturnType<typeof vi.fn>;
      }
    > = [];
    const supervisor = new RunnerConnectionSupervisor('grpc.test:443', () => {
      const transport = {
        start: vi.fn(),
        shutdown: vi.fn(),
        request: vi.fn(async () => ({ ok: true })),
        publish: vi.fn(),
      };
      transports.push(transport);
      return transport;
    });

    supervisor.activate(options());
    supervisor.activate(options());
    expect(transports[0]?.shutdown).toHaveBeenCalledWith('runner connection replaced');
    expect(transports[1]?.start).toHaveBeenCalledOnce();

    supervisor.shutdown('done');
    expect(transports[1]?.shutdown).toHaveBeenCalledWith('done');
    expect(supervisor.isActive()).toBe(false);
  });
});
