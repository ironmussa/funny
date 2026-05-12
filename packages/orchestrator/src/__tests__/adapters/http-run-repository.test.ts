/**
 * Unit tests for HttpOrchestratorRunRepository — verify each method
 * issues the right HTTP call and decodes the response.
 */

import { describe, expect, test } from 'bun:test';

import { HttpOrchestratorClient } from '../../adapters/http-client.js';
import { HttpOrchestratorRunRepository } from '../../adapters/http-run-repository.js';

interface FakeCall {
  method: string;
  path: string;
  body: string | null;
}

function fakeClient(responder: (call: FakeCall) => unknown): {
  client: HttpOrchestratorClient;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    const u = new URL(url);
    const path = u.pathname + (u.search || '');
    const call: FakeCall = {
      method: (init?.method ?? 'GET').toUpperCase(),
      path,
      body: typeof init?.body === 'string' ? init.body : null,
    };
    calls.push(call);
    const result = responder(call);
    return new Response(result === undefined ? '' : JSON.stringify(result), {
      status: result === undefined ? 204 : 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const client = new HttpOrchestratorClient({
    baseUrl: 'http://srv',
    authSecret: 's',
    fetch: fakeFetch,
  });
  return { client, calls };
}

const fakeRow = {
  threadId: 't1',
  pipelineRunId: null,
  attempt: 0,
  nextRetryAtMs: null,
  lastEventAtMs: 1_000,
  lastError: null,
  claimedAtMs: 1_000,
  userId: 'u1',
  tokensTotal: 0,
  updatedAtMs: 1_000,
};

describe('HttpOrchestratorRunRepository', () => {
  test('claim issues POST /runs with args and returns the row', async () => {
    const { client, calls } = fakeClient(() => ({ run: fakeRow }));
    const repo = new HttpOrchestratorRunRepository(client);

    const row = await repo.claim({ threadId: 't1', userId: 'u1', now: 1_000 });
    expect(row).toEqual(fakeRow);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].path).toBe('/api/orchestrator/system/runs');
    expect(JSON.parse(calls[0].body!)).toEqual({ threadId: 't1', userId: 'u1', now: 1_000 });
  });

  test('release issues DELETE /runs/:threadId', async () => {
    const { client, calls } = fakeClient(() => undefined);
    const repo = new HttpOrchestratorRunRepository(client);

    await repo.release('t1');
    expect(calls[0].method).toBe('DELETE');
    expect(calls[0].path).toBe('/api/orchestrator/system/runs/t1');
  });

  test('getRun returns undefined when server reports null', async () => {
    const { client } = fakeClient(() => ({ run: null }));
    const repo = new HttpOrchestratorRunRepository(client);

    const row = await repo.getRun('t1');
    expect(row).toBeUndefined();
  });

  test('listActiveRuns returns runs array', async () => {
    const { client } = fakeClient(() => ({ runs: [fakeRow] }));
    const repo = new HttpOrchestratorRunRepository(client);
    const rows = await repo.listActiveRuns();
    expect(rows).toEqual([fakeRow]);
  });

  test('setPipelineRunId issues PATCH with setPipelineRunId payload', async () => {
    const { client, calls } = fakeClient(() => ({ ok: true }));
    const repo = new HttpOrchestratorRunRepository(client);

    await repo.setPipelineRunId('t1', 'pr-abc');
    expect(calls[0].method).toBe('PATCH');
    expect(calls[0].path).toBe('/api/orchestrator/system/runs/t1');
    expect(JSON.parse(calls[0].body!)).toEqual({ setPipelineRunId: 'pr-abc' });
  });

  test('setRetry sends nested setRetry payload', async () => {
    const { client, calls } = fakeClient(() => ({ ok: true }));
    const repo = new HttpOrchestratorRunRepository(client);

    await repo.setRetry({
      threadId: 't1',
      attempt: 2,
      nextRetryAtMs: 5_000,
      lastError: 'timeout',
    });
    expect(JSON.parse(calls[0].body!)).toEqual({
      setRetry: { attempt: 2, nextRetryAtMs: 5_000, lastError: 'timeout' },
    });
  });

  test('listDueRetries serializes now as query', async () => {
    const { client, calls } = fakeClient(() => ({ runs: [] }));
    const repo = new HttpOrchestratorRunRepository(client);

    await repo.listDueRetries(7_777);
    expect(calls[0].path).toBe('/api/orchestrator/system/runs/due-retries?now=7777');
  });

  test('listDependenciesFor builds map and skips empty input', async () => {
    const { client, calls } = fakeClient(() => ({
      dependencies: { t1: ['t2', 't3'], t4: ['t5'] },
    }));
    const repo = new HttpOrchestratorRunRepository(client);

    const empty = await repo.listDependenciesFor([]);
    expect(empty.size).toBe(0);
    expect(calls).toHaveLength(0);

    const map = await repo.listDependenciesFor(['t1', 't4']);
    expect(map.size).toBe(2);
    expect(map.get('t1')).toEqual(['t2', 't3']);
    expect(map.get('t4')).toEqual(['t5']);
    expect(calls[0].path).toBe('/api/orchestrator/system/dependencies?threadIds=t1%2Ct4');
  });

  test('addDependency POSTs threadId+blockedBy', async () => {
    const { client, calls } = fakeClient(() => ({ ok: true }));
    const repo = new HttpOrchestratorRunRepository(client);

    await repo.addDependency('t1', 't2');
    expect(calls[0].method).toBe('POST');
    expect(JSON.parse(calls[0].body!)).toEqual({ threadId: 't1', blockedBy: 't2' });
  });
});
