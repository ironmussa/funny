import { createClient } from '@abbacchio/transport';
import { getTelemetryIdentity } from '@funny/shared/lib/telemetry-identity';
import { expect, test, vi } from 'vitest';

test('sends emitter identity with logs, metrics and traces', async () => {
  const identity = getTelemetryIdentity('funny-runtime');
  const requests: Array<{ url: string; headers: Headers; body: string }> = [];
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        requests.push({
          url: String(input),
          headers: new Headers(init?.headers),
          body: String(init?.body),
        });
        return new Response('{}', { status: 200 });
      },
      { preconnect: fetch.preconnect },
    ),
  );
  const client = createClient({
    ...identity,
    endpoint: 'http://collector.test',
    serviceName: 'funny-runtime',
    enabled: true,
  });
  try {
    client.add({ level: 30, time: Date.now(), msg: 'identity regression test' });
    client.addMetric({ name: 'test.count', type: 'sum', value: 1 });
    client.addSpan({
      traceId: 'a'.repeat(32),
      spanId: 'b'.repeat(16),
      name: 'test.span',
      startTimeUnixNano: '1000000',
      endTimeUnixNano: '2000000',
    });
    await client.flush();
    expect(requests.map(({ url }) => url).sort()).toEqual([
      'http://collector.test/v1/logs',
      'http://collector.test/v1/metrics',
      'http://collector.test/v1/traces',
    ]);
    for (const request of requests) {
      expect(request.headers.get('X-Source')).toBe('funny-runtime');
      expect(request.headers.get('X-Instance-Id')).toBe(identity.instanceId);
      expect(request.body).toContain('service.instance.id');
      expect(request.body).toContain(identity.instanceId);
    }
  } finally {
    await client.close();
    fetchMock.mockRestore();
  }
});
