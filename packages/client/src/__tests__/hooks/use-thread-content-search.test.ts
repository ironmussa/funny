import { afterEach, beforeEach, describe, expect, mock, test, vi } from 'bun:test';

import { advanceTimersByTimeAsync } from '@funny/test-kit';
import { act, renderHook } from '@testing-library/react';
import { okAsync } from 'neverthrow';

import { useThreadContentSearch } from '@/hooks/use-thread-content-search';

const searchThreadContent = vi.fn();
mock.module('@/lib/api', () => ({ api: { searchThreadContent } }));

beforeEach(() => {
  vi.useFakeTimers();
  searchThreadContent.mockImplementation((q: string) =>
    okAsync({ threadIds: [`t-${q}`], snippets: { [`t-${q}`]: `about ${q}` } }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

const render = (search: string) =>
  renderHook(({ q }) => useThreadContentSearch(q, null, false), { initialProps: { q: search } });

describe('useThreadContentSearch', () => {
  test('a cached search shows its matches at once, without asking the server again', async () => {
    const view = render('alpha');
    await act(async () => advanceTimersByTimeAsync(300));
    expect([...view.result.current.keys()]).toEqual(['t-alpha']);

    view.rerender({ q: 'beta' });
    await act(async () => advanceTimersByTimeAsync(300));
    expect([...view.result.current.keys()]).toEqual(['t-beta']);

    view.rerender({ q: 'alpha' });
    expect([...view.result.current.keys()]).toEqual(['t-alpha']);
    await act(async () => advanceTimersByTimeAsync(300));
    expect(searchThreadContent).toHaveBeenCalledTimes(2);
  });

  test('clearing the search clears the matches in the same render', async () => {
    const view = render('alpha');
    await act(async () => advanceTimersByTimeAsync(300));
    expect(view.result.current.size).toBe(1);

    view.rerender({ q: '  ' });
    expect(view.result.current.size).toBe(0);
  });

  test('an uncached search keeps the previous matches until the server answers', async () => {
    const view = render('alpha');
    await act(async () => advanceTimersByTimeAsync(300));
    view.rerender({ q: 'gamma' });
    expect([...view.result.current.keys()]).toEqual(['t-alpha']);
    await act(async () => advanceTimersByTimeAsync(300));
    expect([...view.result.current.keys()]).toEqual(['t-gamma']);
  });
});
