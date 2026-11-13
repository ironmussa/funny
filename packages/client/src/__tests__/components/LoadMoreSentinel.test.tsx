import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { LoadMoreSentinel } from '@/components/LoadMoreSentinel';

type Callback = (entries: Array<{ isIntersecting: boolean }>) => void;

let observers: Array<{ callback: Callback; disconnected: boolean }> = [];

class FakeIntersectionObserver {
  private entry: { callback: Callback; disconnected: boolean };
  constructor(callback: Callback) {
    this.entry = { callback, disconnected: false };
    observers.push(this.entry);
  }
  observe() {}
  disconnect() {
    this.entry.disconnected = true;
  }
}

/** Report an intersection to every observer still connected. */
function scrollIntoView(isIntersecting = true) {
  act(() => {
    for (const o of observers.filter((o) => !o.disconnected)) o.callback([{ isIntersecting }]);
  });
}

describe('LoadMoreSentinel', () => {
  beforeEach(() => {
    observers = [];
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
  });
  afterEach(() => vi.unstubAllGlobals());

  test('loads the next page once when it scrolls into view', () => {
    const onLoadMore = vi.fn();
    render(
      <LoadMoreSentinel
        hasMore
        loading={false}
        onLoadMore={onLoadMore}
        itemCount={10}
        testId="s"
      />,
    );

    scrollIntoView(false);
    expect(onLoadMore).not.toHaveBeenCalled();

    scrollIntoView();
    scrollIntoView();
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  test('does not load while a page is loading, and shows a spinner', () => {
    const onLoadMore = vi.fn();
    render(<LoadMoreSentinel hasMore loading onLoadMore={onLoadMore} itemCount={10} testId="s" />);

    scrollIntoView();
    expect(onLoadMore).not.toHaveBeenCalled();
    expect(screen.getByTestId('s')).toHaveAttribute('aria-busy', 'true');
  });

  test('observes again after a page finishes loading', () => {
    const onLoadMore = vi.fn();
    const { rerender } = render(
      <LoadMoreSentinel
        hasMore
        loading={false}
        onLoadMore={onLoadMore}
        itemCount={10}
        testId="s"
      />,
    );
    scrollIntoView();
    rerender(
      <LoadMoreSentinel hasMore loading onLoadMore={onLoadMore} itemCount={10} testId="s" />,
    );
    rerender(
      <LoadMoreSentinel
        hasMore
        loading={false}
        onLoadMore={onLoadMore}
        itemCount={10}
        testId="s"
      />,
    );

    scrollIntoView();
    expect(onLoadMore).toHaveBeenCalledTimes(2);
  });

  test('observes again when rows are revealed without a loading phase', () => {
    const onLoadMore = vi.fn();
    const { rerender } = render(
      <LoadMoreSentinel hasMore itemCount={20} onLoadMore={onLoadMore} testId="s" />,
    );
    scrollIntoView();
    rerender(<LoadMoreSentinel hasMore itemCount={40} onLoadMore={onLoadMore} testId="s" />);

    scrollIntoView();
    expect(onLoadMore).toHaveBeenCalledTimes(2);
  });

  test('renders nothing when there are no more pages', () => {
    const onLoadMore = vi.fn();
    render(
      <LoadMoreSentinel
        hasMore={false}
        loading={false}
        onLoadMore={onLoadMore}
        itemCount={10}
        testId="s"
      />,
    );

    expect(screen.queryByTestId('s')).toBeNull();
    scrollIntoView();
    expect(onLoadMore).not.toHaveBeenCalled();
  });
});
