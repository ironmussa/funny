import { describe, test, expect, vi, beforeEach } from 'vitest';

// Mock fetch before importing the API, like api.test.ts.
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);
delete (window as any).__TAURI_INTERNALS__;

const { automationsApi } = await import('@/lib/api/automations');
const { pipelinesApi } = await import('@/lib/api/pipelines');
const { trpc, trpcCall } = await import('@/lib/api/_trpc');
const { useCircuitBreakerStore } = await import('@/stores/circuit-breaker-store');

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function trpcError(status: number, code: string, message: string, extra: object = {}) {
  return json(
    { error: { message, code: -32000, ...extra, data: { code, httpStatus: status } } },
    status,
  );
}

const lastCall = () => mockFetch.mock.calls.at(-1) as [string, RequestInit];

describe('tRPC procedure calls (automations)', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    useCircuitBreakerStore.setState({ state: 'closed', failureCount: 0, _cooldownTimer: null });
  });

  test('a query is a GET with the input in ?input= and unwraps result.data', async () => {
    mockFetch.mockResolvedValueOnce(json({ result: { data: [{ id: 'a1' }] } }));

    const result = await automationsApi.listAutomations('p1');

    expect(result._unsafeUnwrap()).toEqual([{ id: 'a1' }]);
    const [url, init] = lastCall();
    expect(url).toContain('/api/trpc/automations.list?input=');
    expect(decodeURIComponent(url.split('?input=')[1])).toBe('{"projectId":"p1"}');
    expect(init.method).toBe('GET');
  });

  test('a mutation is a POST with the input as JSON body', async () => {
    mockFetch.mockResolvedValueOnce(json({ result: { data: { id: 'a1', enabled: false } } }));

    const result = await automationsApi.updateAutomation('a1', { enabled: false });

    expect(result._unsafeUnwrap()).toEqual({ id: 'a1', enabled: false });
    const [url, init] = lastCall();
    expect(url).toMatch(/\/api\/trpc\/automations\.update$/);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ id: 'a1', data: { enabled: false } });
  });

  test('a procedure failure becomes the same DomainError a REST call produces', async () => {
    mockFetch.mockResolvedValueOnce(trpcError(404, 'NOT_FOUND', 'Not found'));

    const result = await automationsApi.getAutomation('a1');

    expect(result._unsafeUnwrapErr()).toEqual({ type: 'NOT_FOUND', message: 'Not found' });
  });

  test('a friendly message from the server reaches the caller', async () => {
    mockFetch.mockResolvedValueOnce(
      trpcError(502, 'BAD_GATEWAY', 'runner offline', {
        friendlyMessage: 'Your runner is offline',
      }),
    );

    const result = await automationsApi.triggerAutomation('a1');

    expect(result._unsafeUnwrapErr()).toEqual({
      type: 'INTERNAL',
      message: 'runner offline',
      friendlyMessage: 'Your runner is offline',
    });
  });

  test('an open circuit fails fast without a request', async () => {
    useCircuitBreakerStore.setState({ state: 'open' });

    const result = await automationsApi.listAutomations();

    expect(result._unsafeUnwrapErr()).toMatchObject({
      type: 'INTERNAL',
      message: 'Server unavailable (circuit open)',
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('a network failure counts toward the circuit breaker like REST', async () => {
    mockFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    const result = await automationsApi.listAutomations();

    expect(result._unsafeUnwrapErr().type).toBe('INTERNAL');
    expect(useCircuitBreakerStore.getState().failureCount).toBe(1);
  });

  test('aborting a call aborts the request and does not count as a failure', async () => {
    mockFetch.mockImplementationOnce(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );
    const controller = new AbortController();

    const pending = trpcCall(() =>
      trpc.automations.list.query(undefined, { signal: controller.signal }),
    );
    controller.abort();
    const result = await pending;

    expect(result._unsafeUnwrapErr()).toEqual({ type: 'INTERNAL', message: 'Request aborted' });
    expect(useCircuitBreakerStore.getState().failureCount).toBe(0);
  });
});

describe('tRPC procedure calls (pipelines)', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    useCircuitBreakerStore.setState({ state: 'closed', failureCount: 0, _cooldownTimer: null });
  });

  test('listPipelines is a tRPC query', async () => {
    mockFetch.mockResolvedValueOnce(json({ result: { data: [{ id: 'pl1' }] } }));

    const result = await pipelinesApi.listPipelines('p1');

    expect(result._unsafeUnwrap()).toEqual([{ id: 'pl1' }]);
    const [url] = lastCall();
    expect(url).toContain('/api/trpc/pipelines.list?input=');
    expect(decodeURIComponent(url.split('?input=')[1])).toBe('{"projectId":"p1"}');
  });

  test('answering an approval gate stays REST (the server may proxy it to a runner)', async () => {
    mockFetch.mockResolvedValueOnce(json({ ok: true }));

    await pipelinesApi.respondToApproval('ap/1', { decision: 'approve' });

    const [url, init] = lastCall();
    expect(url).toMatch(/\/api\/pipelines\/approvals\/ap%2F1\/respond$/);
    expect(init.method).toBe('POST');
  });
});
