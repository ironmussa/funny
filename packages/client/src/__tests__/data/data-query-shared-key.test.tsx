import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { render, waitFor } from '@testing-library/react';

import { useDataQuery } from '@/data/hooks';

import { installTestDataLayer, resetTestDataLayer } from '../helpers/data-layer-harness';

beforeEach(() => installTestDataLayer());
afterEach(() => resetTestDataLayer());

const key = ['shared-key-test'] as const;
let calls = 0;
const queryFn = () => {
  calls += 1;
  return Promise.resolve({ value: 'loaded' });
};

function Fetching() {
  const { data } = useDataQuery({ queryKey: key, queryFn, staleTime: 10_000 });
  return <span data-testid="fetching">{data?.value ?? 'none'}</span>;
}

function CacheOnly() {
  const { data } = useDataQuery({ queryKey: key, queryFn, staleTime: 10_000, enabled: false });
  return <span data-testid="cache-only">{data?.value ?? 'none'}</span>;
}

describe('useDataQuery on a shared key', () => {
  // Regression: one observer was shared per key, so a cache-only reader
  // (enabled: false, e.g. the sidebar's current-branch label) and a fetching
  // reader of the same key reset each other's options on every render, which
  // ended in "Maximum update depth exceeded" (the factory's base branch setting).
  test('a cache-only reader and a fetching reader settle together', async () => {
    calls = 0;
    const view = render(
      <>
        <CacheOnly />
        <Fetching />
      </>,
    );
    await waitFor(() => expect(view.getByTestId('fetching').textContent).toBe('loaded'));
    expect(view.getByTestId('cache-only').textContent).toBe('loaded');
    expect(calls).toBe(1);
  });
});
