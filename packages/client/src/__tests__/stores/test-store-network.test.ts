import { beforeEach, describe, expect, test } from 'bun:test';

import type { TestNetworkEntry } from '@funny/shared';

import { useTestStore } from '@/stores/test-store';

const request: TestNetworkEntry = {
  id: 'req-1',
  method: 'GET',
  url: 'https://example.test/api',
  startTime: 1000,
  statusText: 'pending',
  requestHeaders: { accept: 'application/json' },
};

describe('useTestStore.handleTestNetwork', () => {
  beforeEach(() => {
    useTestStore.getState().reset();
  });

  test('a request phase appends the entry', () => {
    useTestStore.getState().handleTestNetwork({ phase: 'request', entry: request });
    expect(useTestStore.getState().networkEntries).toEqual([request]);
  });

  test('a later phase overwrites only the fields it carries', () => {
    const store = useTestStore.getState();
    store.handleTestNetwork({ phase: 'request', entry: request });
    store.handleTestNetwork({
      phase: 'completed',
      entry: {
        id: 'req-1',
        // Empty / falsy values of truthy-checked fields keep the earlier value.
        method: '',
        url: '',
        statusText: '',
        failed: false,
        startTime: 0,
        // Non-null-checked fields are copied even when 0 / false.
        status: 0,
        size: 0,
        responseBodyBase64: false,
        mimeType: 'application/json',
        responseBody: '{}',
        endTime: 1250,
      },
    });

    expect(useTestStore.getState().networkEntries).toEqual([
      {
        ...request,
        status: 0,
        size: 0,
        responseBodyBase64: false,
        mimeType: 'application/json',
        responseBody: '{}',
        endTime: 1250,
        duration: 250,
      },
    ]);
  });

  test('an update for another id leaves the entry untouched', () => {
    const store = useTestStore.getState();
    store.handleTestNetwork({ phase: 'request', entry: request });
    store.handleTestNetwork({
      phase: 'response',
      entry: { id: 'other', method: 'POST', url: 'x', startTime: 0, status: 500 },
    });
    expect(useTestStore.getState().networkEntries).toEqual([request]);
  });
});
