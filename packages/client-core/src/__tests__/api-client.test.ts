import { describe, expect, test } from 'bun:test';

import { createApiClient, type ApiClientDependencies, type ApiClientError } from '../api-client';
import { createEndpointPolicy } from '../endpoint-policy';
import { createInMemoryPlatform } from '../testing/in-memory-platform';

function response(status: number, body: unknown) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return { status, ok: status >= 200 && status < 300, headers: {}, text: async () => text };
}

function createDependencies(
  request: NonNullable<Parameters<typeof createInMemoryPlatform>[0]>['request'],
) {
  const host = createInMemoryPlatform({ request });
  const circuit = { state: 'closed' as 'closed' | 'open' | 'half-open', failures: 0, successes: 0 };
  const unauthorized: string[] = [];
  const failures: Parameters<
    NonNullable<ApiClientDependencies['telemetry']['reportFailure']>
  >[0][] = [];
  const dependencies: ApiClientDependencies = {
    transport: host.platform.transport,
    endpointPolicy: createEndpointPolicy(host.platform.transport.environment),
    clock: () => 100,
    telemetry: {
      startSpan: () => ({ traceparent: 'trace', end: () => undefined }),
      metric: () => undefined,
      reportFailure: (failure) => failures.push(failure),
    },
    circuitBreaker: {
      snapshot: () => circuit,
      recordFailure: () => circuit.failures++,
      recordSuccess: () => circuit.successes++,
    },
    onUnauthorized: (path) => unauthorized.push(path),
    networkFriendlyMessage: () => 'Check your connection',
  };
  return { client: createApiClient(dependencies), circuit, unauthorized, failures, dependencies };
}

describe('API client', () => {
  test('returns decoded success and records circuit success', async () => {
    const fixture = createDependencies(async () => response(200, { ok: true }));
    expect(await fixture.client.request('/profile')).toEqual({ ok: true });
    expect(fixture.circuit.successes).toBe(1);
    expect(fixture.failures).toEqual([]);
  });

  test('reports HTTP errors with context without arbitrary query values or request bodies', async () => {
    const fixture = createDependencies(async () =>
      response(400, { error: 'Could not determine remote URL for this project' }),
    );
    await expect(
      fixture.client.request('/gh/prs?projectId=p1&token=secret', {
        method: 'POST',
        body: 'private request',
      }),
    ).rejects.toMatchObject({ type: 'BAD_REQUEST' });
    expect(fixture.failures).toEqual([
      {
        kind: 'http',
        method: 'POST',
        path: '/gh/prs',
        projectId: 'p1',
        status: 400,
        error: 'Could not determine remote URL for this project',
        durationMs: 0,
        traceparent: 'trace',
      },
    ]);
  });

  test('uses the HTTP status for non-JSON errors and tolerates a broken logging sink', async () => {
    const fixture = createDependencies(async () => response(502, '<html>Bad gateway</html>'));
    await fixture.client.request('/gh/prs').catch(() => undefined);
    expect(fixture.failures[0]).toMatchObject({ status: 502, error: 'HTTP 502' });
    fixture.dependencies.telemetry.reportFailure = () => {
      throw new Error('logging unavailable');
    };
    await expect(fixture.client.request('/gh/prs')).rejects.toMatchObject({
      type: 'INTERNAL',
      message: 'HTTP 502',
    });
  });

  test('handles server errors, exclusions, and unauthorized callbacks', async () => {
    const server = createDependencies(async () => response(500, { error: 'broken' }));
    expect(server.client.request('/projects')).rejects.toMatchObject({
      type: 'INTERNAL',
      message: 'broken',
    });
    await server.client.request('/projects').catch(() => undefined);
    expect(server.circuit.failures).toBe(2);

    const proxy = createDependencies(async () => response(502, { error: 'runner down' }));
    await proxy.client.request('/git/status').catch(() => undefined);
    expect(proxy.circuit.failures).toBe(0);

    const auth = createDependencies(async () => response(401, { error: 'Unauthorized' }));
    await auth.client.request('/threads?limit=1').catch(() => undefined);
    expect(auth.unauthorized).toEqual(['/threads']);
  });

  test('reports network failures and rejects while the circuit is open', async () => {
    const fixture = createDependencies(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(fixture.client.request('/projects')).rejects.toMatchObject({
      type: 'INTERNAL',
      friendlyMessage: 'Check your connection',
    });
    expect(fixture.circuit.failures).toBe(1);
    expect(fixture.failures).toHaveLength(1);
    expect(fixture.failures[0]).toMatchObject({
      kind: 'network',
      status: 0,
      path: '/projects',
      error: 'TypeError: Failed to fetch',
    });
    fixture.circuit.state = 'open';
    await expect(fixture.client.request('/projects')).rejects.toMatchObject({
      message: 'Server unavailable (circuit open)',
    });
    expect(fixture.failures).toHaveLength(1);
  });

  test('distinguishes cancellation from a network failure', async () => {
    const fixture = createDependencies(async () => {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    });
    const error = await fixture.client
      .request('/threads/one', {
        cancellation: { aborted: true, subscribe: () => () => undefined },
      })
      .catch((value: ApiClientError) => value);
    expect(error).toMatchObject({ type: 'INTERNAL', message: 'Request aborted' });
    expect(fixture.circuit.failures).toBe(0);
    expect(fixture.failures).toEqual([]);
  });
});
