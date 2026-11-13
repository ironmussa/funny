/**
 * Reopening the Issues / PRs tab cleared the list and showed the spinner until
 * GitHub answered again. The rows now stay while page 1 reloads; they are
 * cleared only when the query changes. Cursor-paged lists (issues over
 * GraphQL) get the previous page's cursor on "load more".
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { okAsync, ResultAsync } from 'neverthrow';
import { describe, expect, test, vi } from 'vitest';

import { type FetchGitHubListPage, usePagedGitHubList } from '@/hooks/use-paged-github-list';

const page = (items: string[], nextCursor: string | null = null) =>
  okAsync({ items, hasMore: nextCursor !== null, nextCursor, owner: 'acme', repo: 'widget' });

function setup(initial: FetchGitHubListPage<string>) {
  return renderHook(
    ({ visible, fetchPage }) => usePagedGitHubList({ visible, fetchPage, errorFallback: 'x' }),
    { initialProps: { visible: true as boolean, fetchPage: initial } },
  );
}

describe('usePagedGitHubList', () => {
  test('keeps the rows while reloading after the tab is shown again', async () => {
    let resolveSecond!: () => void;
    const fetchPage = vi
      .fn<FetchGitHubListPage<string>>()
      .mockReturnValueOnce(page(['a']))
      .mockReturnValueOnce(
        ResultAsync.fromSafePromise(
          new Promise<void>((r) => {
            resolveSecond = r;
          }),
        ).andThen(() => page(['a', 'b'])),
      );
    const view = setup(fetchPage);
    await waitFor(() => expect(view.result.current.items).toEqual(['a']));

    view.rerender({ visible: false, fetchPage });
    view.rerender({ visible: true, fetchPage });
    await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(2));
    expect(view.result.current.items).toEqual(['a']);
    expect(view.result.current.loading).toBe(true);

    await act(async () => resolveSecond());
    await waitFor(() => expect(view.result.current.items).toEqual(['a', 'b']));
  });

  test('clears the rows when the query changes', async () => {
    const first = vi.fn<FetchGitHubListPage<string>>().mockReturnValue(page(['open-1']));
    const view = setup(first);
    await waitFor(() => expect(view.result.current.items).toEqual(['open-1']));

    const second = vi
      .fn<FetchGitHubListPage<string>>()
      .mockReturnValue(ResultAsync.fromSafePromise(new Promise<never>(() => {})));
    view.rerender({ visible: true, fetchPage: second });
    await waitFor(() => expect(second).toHaveBeenCalled());
    expect(view.result.current.items).toEqual([]);
  });

  test('passes the previous page cursor on load more, none on refresh', async () => {
    const fetchPage = vi
      .fn<FetchGitHubListPage<string>>()
      .mockReturnValueOnce(page(['a'], 'CUR1'))
      .mockReturnValueOnce(page(['b']))
      .mockReturnValueOnce(page(['a'], 'CUR1'));
    const view = setup(fetchPage);
    await waitFor(() => expect(view.result.current.hasMore).toBe(true));

    act(() => view.result.current.loadMore());
    await waitFor(() => expect(view.result.current.items).toEqual(['a', 'b']));
    expect(fetchPage.mock.calls[0][2]).toBeUndefined();
    expect(fetchPage.mock.calls[1][2]).toBe('CUR1');

    act(() => view.result.current.refresh());
    await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(3));
    expect(fetchPage.mock.calls[2][2]).toBeUndefined();
  });
});
