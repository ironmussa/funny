import { act, render } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { FrozenMessageStream } from '@/components/thread/FrozenMessageStream';
import type { MessageStreamHandle } from '@/components/thread/message-stream-types';

import { mockT } from '../helpers/mock-i18n';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mockT, i18n: { language: 'en' } }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

vi.mock('@/lib/telemetry', () => ({
  metric: () => {},
  startSpan: () => ({ end: () => {} }),
}));

vi.mock('@/components/thread/FrozenMessageList', () => ({
  FrozenMessageList: () => <div data-testid="frozen-message-list-mock" />,
}));

vi.mock('@/components/thread/InitInfoCard', () => ({ InitInfoCard: () => null }));
vi.mock('@/components/thread/MessageStreamStatusTail', () => ({
  MessageStreamStatusTail: () => null,
}));

// Controllable IntersectionObserver: record instances so tests can fire
// intersection for a specific sentinel target.
const observers: { cb: IntersectionObserverCallback; targets: Element[]; self: any }[] = [];
class MockIntersectionObserver {
  cb: IntersectionObserverCallback;
  targets: Element[] = [];
  constructor(cb: IntersectionObserverCallback) {
    this.cb = cb;
    observers.push({ cb, targets: this.targets, self: this });
  }
  observe(el: Element) {
    this.targets.push(el);
  }
  unobserve() {}
  disconnect() {}
}

function fireIntersect(target: Element | null) {
  if (!target) throw new Error('no target');
  for (const o of observers) {
    if (o.targets.includes(target)) {
      o.cb([{ target, isIntersecting: true } as IntersectionObserverEntry], o.self);
    }
  }
}

function baseProps(overrides: Partial<Parameters<typeof FrozenMessageStream>[0]> = {}) {
  return {
    threadId: 't1',
    status: 'idle',
    messages: [
      { id: 'u1', threadId: 't1', role: 'user', content: 'hi', timestamp: '2026-01-01T00:00:00Z' },
    ],
    onSend: () => {},
    ...overrides,
  } as Parameters<typeof FrozenMessageStream>[0];
}

describe('FrozenMessageStream infinite scroll', () => {
  beforeEach(() => {
    observers.length = 0;
    vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);
    window.localStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('renders both sentinels when there is older and newer history', () => {
    const { getByTestId } = render(
      <FrozenMessageStream
        {...baseProps({
          pagination: {
            hasMore: true,
            hasMoreAfter: true,
            loadingMore: false,
            load: () => {},
            loadAfter: () => {},
          },
        })}
      />,
    );
    expect(getByTestId('frozen-top-sentinel')).toBeTruthy();
    expect(getByTestId('frozen-bottom-sentinel')).toBeTruthy();
    expect(getByTestId('frozen-message-list-mock')).toBeTruthy();
  });

  test('top sentinel loads older, bottom sentinel loads newer', () => {
    const load = vi.fn();
    const loadAfter = vi.fn();
    const { getByTestId } = render(
      <FrozenMessageStream
        {...baseProps({
          pagination: { hasMore: true, hasMoreAfter: true, loadingMore: false, load, loadAfter },
        })}
      />,
    );

    act(() => fireIntersect(getByTestId('frozen-top-sentinel')));
    expect(load).toHaveBeenCalledTimes(1);
    expect(loadAfter).not.toHaveBeenCalled();

    act(() => fireIntersect(getByTestId('frozen-bottom-sentinel')));
    expect(loadAfter).toHaveBeenCalledTimes(1);
  });

  test('does not load while a page is already loading', () => {
    const load = vi.fn();
    const { getByTestId } = render(
      <FrozenMessageStream
        {...baseProps({
          pagination: {
            hasMore: true,
            hasMoreAfter: false,
            loadingMore: true,
            load,
            loadAfter: () => {},
          },
        })}
      />,
    );
    act(() => fireIntersect(getByTestId('frozen-top-sentinel')));
    expect(load).not.toHaveBeenCalled();
  });

  test('omits the top sentinel entirely when there is no pagination', () => {
    const { queryByTestId } = render(<FrozenMessageStream {...baseProps()} />);
    expect(queryByTestId('frozen-top-sentinel')).toBeNull();
    expect(queryByTestId('frozen-bottom-sentinel')).toBeNull();
  });

  test('exposes a scrollToBottom handle that pins the viewport', () => {
    const ref = createRef<MessageStreamHandle>();
    const { container } = render(<FrozenMessageStream {...baseProps({ ref })} />);
    const viewport = container.firstElementChild as HTMLDivElement;
    Object.defineProperty(viewport, 'scrollHeight', { configurable: true, get: () => 5000 });
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, get: () => 500 });

    act(() => ref.current!.scrollToBottom());
    expect(viewport.scrollTop).toBe(5000);
  });
});
