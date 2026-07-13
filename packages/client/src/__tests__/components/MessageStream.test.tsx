import { act, render } from '@testing-library/react';
import { createRef, useEffect, useImperativeHandle, type Ref } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { MessageStream, type MessageStreamHandle } from '@/components/thread/MessageStream';
import {
  loadThreadScrollFetchOptions,
  saveThreadScrollPosition,
} from '@/lib/thread-scroll-position';
import { useSettingsStore } from '@/stores/settings-store';

import { mockT } from '../helpers/mock-i18n';

class MockIntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: mockT,
    i18n: { language: 'en' },
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

const memoizedMessageListLifecycle = vi.hoisted(() => ({
  mounts: 0,
  unmounts: 0,
  captureScrollAnchorCalls: 0,
  restoreScrollAnchorCalls: 0,
  captureVisibleAnchorCalls: 0,
  restoredAnchors: [] as any[],
  visibleAnchor: null as { key: string; offsetFromViewportTop: number } | null,
  restoreScrollAnchorResult: true,
  hasHiddenItems: false,
}));

vi.mock('@/components/thread/MemoizedMessageList', () => ({
  EMPTY_MESSAGES: [],
  MemoizedMessageList: function MockMemoizedMessageList({
    messages,
    ref,
  }: {
    messages: any[];
    ref?: Ref<any>;
  }) {
    useEffect(() => {
      memoizedMessageListLifecycle.mounts += 1;
      return () => {
        memoizedMessageListLifecycle.unmounts += 1;
      };
    }, []);

    useImperativeHandle(ref, () => ({
      expandToItem: () => {},
      hasHiddenItems: () => memoizedMessageListLifecycle.hasHiddenItems,
      captureScrollAnchor: () => {
        memoizedMessageListLifecycle.captureScrollAnchorCalls += 1;
      },
      restoreScrollAnchor: (anchor?: any) => {
        memoizedMessageListLifecycle.restoreScrollAnchorCalls += 1;
        memoizedMessageListLifecycle.restoredAnchors.push(anchor);
        return memoizedMessageListLifecycle.restoreScrollAnchorResult;
      },
      captureVisibleAnchor: () => {
        memoizedMessageListLifecycle.captureVisibleAnchorCalls += 1;
        return memoizedMessageListLifecycle.visibleAnchor;
      },
    }));

    return (
      <div>
        {messages.map((message) => (
          <div key={message.id} data-item-key={message.id}>
            {message.content}
          </div>
        ))}
      </div>
    );
  },
}));

vi.mock('@/components/thread/FrozenMessageList', () => ({
  FrozenMessageList: () => <div data-testid="frozen-message-list-mock" />,
}));

vi.mock('@/components/thread/AgentStatusCards', () => ({
  AgentResultCard: () => null,
  AgentInterruptedCard: () => null,
  AgentStoppedCard: () => null,
}));

vi.mock('@/components/thread/InitInfoCard', () => ({
  InitInfoCard: () => null,
}));

vi.mock('@/components/thread/WaitingCards', () => ({
  WaitingActions: () => null,
  PermissionApprovalCard: () => null,
  ProviderErrorCard: () => null,
}));

vi.mock('@/components/D4CAnimation', () => ({
  D4CAnimation: () => null,
}));

function makeMessages(assistantContent: string) {
  return [
    {
      id: 'u1',
      threadId: 't1',
      role: 'user',
      content: 'Do the thing',
      timestamp: '2026-01-01T00:00:00.000Z',
    },
    {
      id: 'a1',
      threadId: 't1',
      role: 'assistant',
      content: assistantContent,
      timestamp: '2026-01-01T00:00:01.000Z',
    },
  ];
}

function makeWindowMessages(threadId: string, count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `${threadId}-m${index}`,
    threadId,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `message ${index}`,
    timestamp: `2026-01-01T00:00:${String(index).padStart(2, '0')}.000Z`,
  }));
}

function setScrollMetrics(
  el: HTMLElement,
  metrics: {
    scrollHeight: () => number;
    clientHeight: () => number;
  },
) {
  Object.defineProperty(el, 'scrollHeight', {
    configurable: true,
    get: metrics.scrollHeight,
  });
  Object.defineProperty(el, 'clientHeight', {
    configurable: true,
    get: metrics.clientHeight,
  });
}

/** Simulate a genuine user scroll: real input (wheel) always precedes the
 *  scroll event in a browser, which ends the post-switch settle window. */
function userScroll(viewport: HTMLElement, top: number) {
  viewport.dispatchEvent(new Event('wheel'));
  viewport.scrollTop = top;
  viewport.dispatchEvent(new Event('scroll'));
}

describe('MessageStream sticky bottom', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      return setTimeout(() => cb(performance.now()), 0) as unknown as number;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
    window.localStorage.clear();
    memoizedMessageListLifecycle.mounts = 0;
    memoizedMessageListLifecycle.unmounts = 0;
    memoizedMessageListLifecycle.captureScrollAnchorCalls = 0;
    memoizedMessageListLifecycle.restoreScrollAnchorCalls = 0;
    memoizedMessageListLifecycle.captureVisibleAnchorCalls = 0;
    memoizedMessageListLifecycle.restoredAnchors = [];
    memoizedMessageListLifecycle.visibleAnchor = null;
    memoizedMessageListLifecycle.restoreScrollAnchorResult = true;
    memoizedMessageListLifecycle.hasHiddenItems = false;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  test('isolates the thread scroller from browser anchoring and overscroll chaining', () => {
    const { container } = render(
      <MessageStream
        threadId="t1"
        status="idle"
        messages={makeMessages('done')}
        onSend={() => {}}
      />,
    );
    const viewport = container.firstElementChild as HTMLDivElement;

    act(() => {
      vi.runOnlyPendingTimers();
    });

    expect(viewport.style.overflowAnchor).toBe('none');
    expect(viewport.style.overscrollBehaviorY).toBe('contain');
  });

  test('keeps the viewport pinned when streamed message content grows', () => {
    let scrollHeight = 1000;
    const ref = createRef<MessageStreamHandle>();
    const { container, rerender } = render(
      <MessageStream
        ref={ref}
        threadId="t1"
        status="running"
        messages={makeMessages('partial')}
        onSend={() => {}}
        isExternal
      />,
    );
    const viewport = container.firstElementChild as HTMLDivElement;
    setScrollMetrics(viewport, {
      scrollHeight: () => scrollHeight,
      clientHeight: () => 500,
    });

    act(() => {
      vi.runOnlyPendingTimers();
      userScroll(viewport, 500);
    });

    scrollHeight = 1300;
    rerender(
      <MessageStream
        ref={ref}
        threadId="t1"
        status="running"
        messages={makeMessages('partial response with more streamed content')}
        onSend={() => {}}
        isExternal
      />,
    );

    act(() => {
      vi.runOnlyPendingTimers();
    });

    expect(viewport.scrollTop).toBe(1300);
  });

  test('does not force-scroll streamed content when the viewport is no longer pinned', () => {
    let scrollHeight = 1000;
    const ref = createRef<MessageStreamHandle>();
    const { container, rerender } = render(
      <MessageStream
        ref={ref}
        threadId="t1"
        status="running"
        messages={makeMessages('partial')}
        onSend={() => {}}
        isExternal
      />,
    );
    const viewport = container.firstElementChild as HTMLDivElement;
    setScrollMetrics(viewport, {
      scrollHeight: () => scrollHeight,
      clientHeight: () => 500,
    });

    act(() => {
      vi.runOnlyPendingTimers();
      userScroll(viewport, 500);
      vi.runOnlyPendingTimers();
    });

    viewport.scrollTop = 300;
    scrollHeight = 1300;
    rerender(
      <MessageStream
        ref={ref}
        threadId="t1"
        status="running"
        messages={makeMessages('partial response with more streamed content')}
        onSend={() => {}}
        isExternal
      />,
    );

    act(() => {
      vi.runOnlyPendingTimers();
    });

    expect(viewport.scrollTop).toBe(300);
  });

  test('cancels pending sticky-bottom frames when the user scrolls up during streaming', () => {
    let scrollHeight = 1000;
    const ref = createRef<MessageStreamHandle>();
    const { container, rerender } = render(
      <MessageStream
        ref={ref}
        threadId="t1"
        status="running"
        messages={makeMessages('partial')}
        onSend={() => {}}
        isExternal
      />,
    );
    const viewport = container.firstElementChild as HTMLDivElement;
    setScrollMetrics(viewport, {
      scrollHeight: () => scrollHeight,
      clientHeight: () => 500,
    });

    act(() => {
      vi.runOnlyPendingTimers();
      userScroll(viewport, 500);
      vi.runOnlyPendingTimers();
    });

    scrollHeight = 1300;
    rerender(
      <MessageStream
        ref={ref}
        threadId="t1"
        status="running"
        messages={makeMessages('partial response with more streamed content')}
        onSend={() => {}}
        isExternal
      />,
    );

    act(() => {
      userScroll(viewport, 600);
      vi.runOnlyPendingTimers();
    });

    expect(viewport.scrollTop).toBe(600);
  });

  test('restores a bottom-pinned long thread after visiting a shorter thread', () => {
    let scrollHeight = 2000;
    const ref = createRef<MessageStreamHandle>();
    const { container, rerender } = render(
      <MessageStream
        ref={ref}
        threadId="long"
        status="idle"
        messages={makeMessages('long thread')}
        onSend={() => {}}
      />,
    );
    const viewport = container.firstElementChild as HTMLDivElement;
    setScrollMetrics(viewport, {
      scrollHeight: () => scrollHeight,
      clientHeight: () => 500,
    });

    act(() => {
      vi.runOnlyPendingTimers();
    });
    expect(viewport.scrollTop).toBe(2000);

    scrollHeight = 650;
    rerender(
      <MessageStream
        ref={ref}
        threadId="short"
        status="idle"
        messages={makeMessages('short thread')}
        onSend={() => {}}
      />,
    );

    act(() => {
      vi.runOnlyPendingTimers();
      userScroll(viewport, 0);
    });

    scrollHeight = 2000;
    rerender(
      <MessageStream
        ref={ref}
        threadId="long"
        status="idle"
        messages={makeMessages('long thread')}
        onSend={() => {}}
      />,
    );

    act(() => {
      vi.runOnlyPendingTimers();
    });

    expect(viewport.scrollTop).toBe(2000);
  });

  test('restores independent non-bottom scroll positions per thread', () => {
    let scrollHeight = 2000;
    const ref = createRef<MessageStreamHandle>();
    const { container, rerender } = render(
      <MessageStream
        ref={ref}
        threadId="long"
        status="idle"
        messages={makeMessages('long thread')}
        onSend={() => {}}
      />,
    );
    const viewport = container.firstElementChild as HTMLDivElement;
    setScrollMetrics(viewport, {
      scrollHeight: () => scrollHeight,
      clientHeight: () => 500,
    });

    act(() => {
      vi.runOnlyPendingTimers();
      userScroll(viewport, 900);
    });

    scrollHeight = 700;
    rerender(
      <MessageStream
        ref={ref}
        threadId="short"
        status="idle"
        messages={makeMessages('short thread')}
        onSend={() => {}}
      />,
    );

    act(() => {
      vi.runOnlyPendingTimers();
      userScroll(viewport, 50);
    });

    scrollHeight = 2000;
    rerender(
      <MessageStream
        ref={ref}
        threadId="long"
        status="idle"
        messages={makeMessages('long thread')}
        onSend={() => {}}
      />,
    );

    act(() => {
      vi.runOnlyPendingTimers();
    });

    expect(viewport.scrollTop).toBe(900);

    scrollHeight = 700;
    rerender(
      <MessageStream
        ref={ref}
        threadId="short"
        status="idle"
        messages={makeMessages('short thread')}
        onSend={() => {}}
      />,
    );

    act(() => {
      vi.runOnlyPendingTimers();
    });

    expect(viewport.scrollTop).toBe(50);
  });

  test('remounts the virtualized list when switching threads', () => {
    const { rerender } = render(
      <MessageStream
        threadId="thread-a"
        status="idle"
        messages={makeMessages('thread a')}
        onSend={() => {}}
      />,
    );

    act(() => {
      vi.runOnlyPendingTimers();
    });

    rerender(
      <MessageStream
        threadId="thread-b"
        status="idle"
        messages={makeMessages('thread b')}
        onSend={() => {}}
      />,
    );

    act(() => {
      vi.runOnlyPendingTimers();
    });

    expect(memoizedMessageListLifecycle.mounts).toBe(2);
    expect(memoizedMessageListLifecycle.unmounts).toBe(1);
  });

  test('does not render phantom spacers for unloaded pages', () => {
    const { queryByTestId } = render(
      <MessageStream
        threadId="t1"
        status="idle"
        messages={makeMessages('loaded window')}
        onSend={() => {}}
        pagination={{
          hasMore: true,
          hasMoreAfter: true,
          loadingMore: false,
          load: () => {},
          loadAfter: () => {},
          total: 100,
          windowStart: 20,
        }}
      />,
    );

    act(() => {
      vi.runOnlyPendingTimers();
    });

    expect(queryByTestId('message-stream-phantom-spacer')).toBeNull();
    expect(queryByTestId('message-stream-bottom-phantom-spacer')).toBeNull();
  });

  test('does not load older pages while scrolling down near the top of the loaded window', () => {
    const scrollHeight = 1000;
    const loadOlder = vi.fn();
    const { container } = render(
      <MessageStream
        threadId="t1"
        status="idle"
        messages={makeMessages('loaded window')}
        onSend={() => {}}
        pagination={{
          hasMore: true,
          loadingMore: false,
          load: loadOlder,
          total: 100,
          windowStart: 20,
        }}
      />,
    );
    const viewport = container.firstElementChild as HTMLDivElement;
    setScrollMetrics(viewport, {
      scrollHeight: () => scrollHeight,
      clientHeight: () => 500,
    });

    act(() => {
      vi.runOnlyPendingTimers();
    });

    act(() => {
      userScroll(viewport, 80);
    });
    loadOlder.mockClear();
    memoizedMessageListLifecycle.captureScrollAnchorCalls = 0;

    act(() => {
      userScroll(viewport, 120);
    });

    expect(loadOlder).not.toHaveBeenCalled();
    expect(memoizedMessageListLifecycle.captureScrollAnchorCalls).toBe(0);
  });

  test('loads older pages when scrolling upward near the loaded window', () => {
    const scrollHeight = 1000;
    const loadOlder = vi.fn();
    const { container } = render(
      <MessageStream
        threadId="t1"
        status="idle"
        messages={makeMessages('loaded window')}
        onSend={() => {}}
        pagination={{
          hasMore: true,
          loadingMore: false,
          load: loadOlder,
          total: 100,
          windowStart: 20,
        }}
      />,
    );
    const viewport = container.firstElementChild as HTMLDivElement;
    setScrollMetrics(viewport, {
      scrollHeight: () => scrollHeight,
      clientHeight: () => 500,
    });

    act(() => {
      vi.runOnlyPendingTimers();
    });

    act(() => {
      userScroll(viewport, 300);
      userScroll(viewport, 100);
    });

    expect(loadOlder).toHaveBeenCalledTimes(1);
    expect(memoizedMessageListLifecycle.captureScrollAnchorCalls).toBe(1);
  });

  test('loads older pages near the top even if virtual rows still report hidden items', () => {
    const scrollHeight = 1000;
    const loadOlder = vi.fn();
    memoizedMessageListLifecycle.hasHiddenItems = true;

    const { container } = render(
      <MessageStream
        threadId="t1"
        status="idle"
        messages={makeMessages('loaded window')}
        onSend={() => {}}
        pagination={{
          hasMore: true,
          loadingMore: false,
          load: loadOlder,
          total: 100,
          windowStart: 20,
        }}
      />,
    );
    const viewport = container.firstElementChild as HTMLDivElement;
    setScrollMetrics(viewport, {
      scrollHeight: () => scrollHeight,
      clientHeight: () => 500,
    });

    act(() => {
      vi.runOnlyPendingTimers();
      userScroll(viewport, 300);
      userScroll(viewport, 100);
    });

    expect(loadOlder).toHaveBeenCalledTimes(1);
    expect(memoizedMessageListLifecycle.captureScrollAnchorCalls).toBe(1);
  });

  test('loads newer pages when scrolling near the bottom of the loaded window', () => {
    const scrollHeight = 1200;
    const loadNewer = vi.fn();
    const { container } = render(
      <MessageStream
        threadId="t1"
        status="idle"
        messages={makeMessages('loaded window')}
        onSend={() => {}}
        pagination={{
          hasMore: false,
          hasMoreAfter: true,
          loadingMore: false,
          load: () => {},
          loadAfter: loadNewer,
          total: 100,
          windowStart: 20,
        }}
      />,
    );
    const viewport = container.firstElementChild as HTMLDivElement;
    setScrollMetrics(viewport, {
      scrollHeight: () => scrollHeight,
      clientHeight: () => 500,
    });

    act(() => {
      vi.runOnlyPendingTimers();
      userScroll(viewport, 650);
    });

    expect(loadNewer).toHaveBeenCalledTimes(1);
  });

  test('keeps the viewport at the loaded bottom after newer messages append', () => {
    let scrollHeight = 1200;
    const loadNewer = vi.fn();
    const initialMessages = makeMessages('loaded window');
    const { container, rerender } = render(
      <MessageStream
        threadId="t1"
        status="idle"
        messages={initialMessages}
        onSend={() => {}}
        pagination={{
          hasMore: false,
          hasMoreAfter: true,
          loadingMore: false,
          load: () => {},
          loadAfter: loadNewer,
          total: 100,
          windowStart: 20,
        }}
      />,
    );
    const viewport = container.firstElementChild as HTMLDivElement;
    setScrollMetrics(viewport, {
      scrollHeight: () => scrollHeight,
      clientHeight: () => 500,
    });

    act(() => {
      vi.runOnlyPendingTimers();
      userScroll(viewport, 650);
    });

    expect(loadNewer).toHaveBeenCalledTimes(1);

    scrollHeight = 1700;
    rerender(
      <MessageStream
        threadId="t1"
        status="idle"
        messages={[
          ...initialMessages,
          {
            id: 'newer',
            threadId: 't1',
            role: 'assistant',
            content: 'newer message',
            timestamp: '2026-01-01T00:00:02.000Z',
          },
        ]}
        onSend={() => {}}
        pagination={{
          hasMore: false,
          hasMoreAfter: true,
          loadingMore: false,
          load: () => {},
          loadAfter: loadNewer,
          total: 100,
          windowStart: 20,
        }}
      />,
    );

    act(() => {
      vi.runOnlyPendingTimers();
    });

    expect(viewport.scrollTop).toBe(1200);
  });

  test('restores paginated scroll progress in full-thread coordinates', () => {
    const scrollHeight = 1500;
    const progressThreadMessages = makeWindowMessages('progress-thread', 10);
    const { container, rerender } = render(
      <MessageStream
        threadId="progress-thread"
        status="idle"
        messages={progressThreadMessages}
        onSend={() => {}}
        pagination={{
          hasMore: true,
          hasMoreAfter: true,
          loadingMore: false,
          load: () => {},
          loadAfter: () => {},
          total: 100,
          windowStart: 40,
        }}
      />,
    );
    const viewport = container.firstElementChild as HTMLDivElement;
    setScrollMetrics(viewport, {
      scrollHeight: () => scrollHeight,
      clientHeight: () => 500,
    });

    act(() => {
      vi.runOnlyPendingTimers();
      userScroll(viewport, 500);
      vi.advanceTimersByTime(300);
    });

    rerender(
      <MessageStream
        threadId="other-thread"
        status="idle"
        messages={makeWindowMessages('other-thread', 10)}
        onSend={() => {}}
      />,
    );

    act(() => {
      vi.runOnlyPendingTimers();
    });

    rerender(
      <MessageStream
        threadId="progress-thread"
        status="idle"
        messages={progressThreadMessages}
        onSend={() => {}}
        pagination={{
          hasMore: true,
          hasMoreAfter: true,
          loadingMore: false,
          load: () => {},
          loadAfter: () => {},
          total: 100,
          windowStart: 40,
        }}
      />,
    );

    act(() => {
      vi.runOnlyPendingTimers();
    });

    expect(viewport.scrollTop).toBe(500);
  });

  test('restores the captured anchor after older messages prepend', () => {
    const scrollHeight = 1000;
    const loadOlder = vi.fn();
    const { container, rerender } = render(
      <MessageStream
        threadId="t1"
        status="idle"
        messages={makeMessages('loaded window')}
        onSend={() => {}}
        pagination={{
          hasMore: true,
          loadingMore: false,
          load: loadOlder,
          total: 100,
          windowStart: 20,
        }}
      />,
    );
    const viewport = container.firstElementChild as HTMLDivElement;
    setScrollMetrics(viewport, {
      scrollHeight: () => scrollHeight,
      clientHeight: () => 500,
    });

    act(() => {
      vi.runOnlyPendingTimers();
      userScroll(viewport, 300);
      userScroll(viewport, 100);
    });

    expect(loadOlder).toHaveBeenCalledTimes(1);
    expect(memoizedMessageListLifecycle.captureScrollAnchorCalls).toBe(1);

    rerender(
      <MessageStream
        threadId="t1"
        status="idle"
        messages={[
          {
            id: 'older',
            threadId: 't1',
            role: 'assistant',
            content: 'older message',
            timestamp: '2025-12-31T23:59:59.000Z',
          },
          ...makeMessages('loaded window'),
        ]}
        onSend={() => {}}
        pagination={{
          hasMore: true,
          loadingMore: false,
          load: loadOlder,
          total: 100,
          windowStart: 19,
        }}
      />,
    );

    act(() => {
      vi.runOnlyPendingTimers();
    });

    expect(memoizedMessageListLifecycle.restoreScrollAnchorCalls).toBe(1);
  });

  test('restores a non-bottom thread by scroll level when content height changes', () => {
    let scrollHeight = 2000;
    const ref = createRef<MessageStreamHandle>();
    const { container, rerender } = render(
      <MessageStream
        ref={ref}
        threadId="long"
        status="idle"
        messages={makeMessages('long thread')}
        onSend={() => {}}
      />,
    );
    const viewport = container.firstElementChild as HTMLDivElement;
    setScrollMetrics(viewport, {
      scrollHeight: () => scrollHeight,
      clientHeight: () => 500,
    });

    act(() => {
      vi.runOnlyPendingTimers();
      userScroll(viewport, 750);
    });

    scrollHeight = 700;
    rerender(
      <MessageStream
        ref={ref}
        threadId="short"
        status="idle"
        messages={makeMessages('short thread')}
        onSend={() => {}}
      />,
    );

    act(() => {
      vi.runOnlyPendingTimers();
    });

    scrollHeight = 2500;
    rerender(
      <MessageStream
        ref={ref}
        threadId="long"
        status="idle"
        messages={makeMessages('long thread with more measured height')}
        onSend={() => {}}
      />,
    );

    act(() => {
      vi.runOnlyPendingTimers();
    });

    expect(viewport.scrollTop).toBe(1000);
  });

  test('a browser clamp during the thread switch cannot poison the outgoing position', () => {
    let scrollHeight = 2000;
    const ref = createRef<MessageStreamHandle>();
    const { container, rerender } = render(
      <MessageStream
        ref={ref}
        threadId="long"
        status="idle"
        messages={makeMessages('long thread')}
        onSend={() => {}}
      />,
    );
    const viewport = container.firstElementChild as HTMLDivElement;
    setScrollMetrics(viewport, {
      scrollHeight: () => scrollHeight,
      clientHeight: () => 500,
    });

    act(() => {
      vi.runOnlyPendingTimers();
      userScroll(viewport, 750);
    });

    // Switching to a shorter thread: the keyed message list swaps to the new
    // content BEFORE the switch effect cleanup runs, and the browser clamps
    // scrollTop to the new max scroll. Neither may overwrite the outgoing
    // thread's saved position (progress 0.5).
    scrollHeight = 700;
    viewport.scrollTop = 200;
    rerender(
      <MessageStream
        ref={ref}
        threadId="short"
        status="idle"
        messages={makeMessages('short thread')}
        onSend={() => {}}
      />,
    );

    act(() => {
      vi.runOnlyPendingTimers();
    });

    scrollHeight = 2500;
    rerender(
      <MessageStream
        ref={ref}
        threadId="long"
        status="idle"
        messages={makeMessages('long thread again')}
        onSend={() => {}}
      />,
    );

    act(() => {
      vi.runOnlyPendingTimers();
    });

    expect(viewport.scrollTop).toBe(1000);
  });

  test('ignores layout-induced scroll events while a thread switch settles', () => {
    let scrollHeight = 800;
    const { container, rerender } = render(
      <MessageStream
        threadId="settle"
        status="idle"
        messages={makeMessages('settle thread')}
        onSend={() => {}}
      />,
    );
    const viewport = container.firstElementChild as HTMLDivElement;
    setScrollMetrics(viewport, {
      scrollHeight: () => scrollHeight,
      clientHeight: () => 500,
    });

    act(() => {
      // Flush only the rAF restore burst; keep the mocked clock inside the
      // settle window (other pending timers would advance it past 700ms).
      vi.advanceTimersByTime(50);
    });
    expect(viewport.scrollTop).toBe(800);

    // The virtualizer measures real row heights right after the switch: the
    // content grows and the browser fires a scroll event at the stale
    // scrollTop. No user input was involved, so the saved bottom position
    // must survive and the thread must still restore pinned to the bottom.
    scrollHeight = 3000;
    act(() => {
      viewport.dispatchEvent(new Event('scroll'));
    });

    expect(loadThreadScrollFetchOptions('settle')).toEqual({ messageProgress: 1 });

    rerender(
      <MessageStream
        threadId="other"
        status="idle"
        messages={makeMessages('other thread')}
        onSend={() => {}}
      />,
    );
    act(() => {
      vi.runOnlyPendingTimers();
    });

    rerender(
      <MessageStream
        threadId="settle"
        status="idle"
        messages={makeMessages('settle thread')}
        onSend={() => {}}
      />,
    );
    act(() => {
      vi.runOnlyPendingTimers();
    });

    expect(viewport.scrollTop).toBe(3000);
  });

  test('honors a user scroll that lands inside the settle window', () => {
    const scrollHeight = 2000;
    const { container, rerender } = render(
      <MessageStream
        threadId="eager"
        status="idle"
        messages={makeMessages('eager thread')}
        onSend={() => {}}
      />,
    );
    const viewport = container.firstElementChild as HTMLDivElement;
    setScrollMetrics(viewport, {
      scrollHeight: () => scrollHeight,
      clientHeight: () => 500,
    });

    // Scroll up immediately after the switch, before the settle window ends.
    // Real input (wheel) precedes the scroll event, so it must be saved.
    act(() => {
      vi.runOnlyPendingTimers();
      userScroll(viewport, 300);
    });

    rerender(
      <MessageStream
        threadId="other"
        status="idle"
        messages={makeMessages('other thread')}
        onSend={() => {}}
      />,
    );
    act(() => {
      vi.runOnlyPendingTimers();
    });

    rerender(
      <MessageStream
        threadId="eager"
        status="idle"
        messages={makeMessages('eager thread')}
        onSend={() => {}}
      />,
    );
    act(() => {
      vi.runOnlyPendingTimers();
    });

    expect(viewport.scrollTop).toBe(300);
  });

  test('prefers the saved visible row anchor over scroll progress when returning to a thread', () => {
    let scrollHeight = 2000;
    memoizedMessageListLifecycle.visibleAnchor = {
      key: 'm-anchor',
      offsetFromViewportTop: -24,
    };
    const ref = createRef<MessageStreamHandle>();
    const { container, rerender } = render(
      <MessageStream
        ref={ref}
        threadId="long"
        status="idle"
        messages={makeMessages('long thread')}
        onSend={() => {}}
      />,
    );
    const viewport = container.firstElementChild as HTMLDivElement;
    setScrollMetrics(viewport, {
      scrollHeight: () => scrollHeight,
      clientHeight: () => 500,
    });

    act(() => {
      vi.runOnlyPendingTimers();
      userScroll(viewport, 750);
    });

    scrollHeight = 700;
    rerender(
      <MessageStream
        ref={ref}
        threadId="short"
        status="idle"
        messages={makeMessages('short thread')}
        onSend={() => {}}
      />,
    );

    act(() => {
      vi.runOnlyPendingTimers();
    });

    scrollHeight = 2500;
    rerender(
      <MessageStream
        ref={ref}
        threadId="long"
        status="idle"
        messages={makeMessages('long thread with more measured height')}
        onSend={() => {}}
      />,
    );

    act(() => {
      vi.runOnlyPendingTimers();
    });

    expect(memoizedMessageListLifecycle.restoreScrollAnchorCalls).toBeGreaterThan(0);
    expect(memoizedMessageListLifecycle.restoredAnchors).toContain(
      memoizedMessageListLifecycle.visibleAnchor,
    );
    expect(viewport.scrollTop).not.toBe(1000);
  });

  test('restores a persisted visible row anchor when mounting a thread', () => {
    saveThreadScrollPosition('persisted', {
      progress: 0.42,
      anchor: { key: 'm-persisted', offsetFromViewportTop: 32 },
    });
    const { container } = render(
      <MessageStream
        threadId="persisted"
        status="idle"
        messages={makeMessages('persisted thread')}
        onSend={() => {}}
      />,
    );
    const viewport = container.firstElementChild as HTMLDivElement;
    setScrollMetrics(viewport, {
      scrollHeight: () => 2000,
      clientHeight: () => 500,
    });

    act(() => {
      vi.runOnlyPendingTimers();
    });

    expect(memoizedMessageListLifecycle.restoredAnchors).toContainEqual({
      key: 'm-persisted',
      offsetFromViewportTop: 32,
    });
  });

  test('stores bottom scroll without a visible row anchor', () => {
    memoizedMessageListLifecycle.visibleAnchor = {
      key: 'm-visible-top',
      offsetFromViewportTop: 16,
    };
    const { container } = render(
      <MessageStream
        threadId="bottom-saved"
        status="idle"
        messages={makeMessages('bottom thread')}
        onSend={() => {}}
      />,
    );
    const viewport = container.firstElementChild as HTMLDivElement;
    setScrollMetrics(viewport, {
      scrollHeight: () => 2000,
      clientHeight: () => 500,
    });

    act(() => {
      vi.runOnlyPendingTimers();
      userScroll(viewport, 1500);
    });

    expect(loadThreadScrollFetchOptions('bottom-saved')).toEqual({
      messageProgress: 1,
    });
  });
});

describe('MessageStream viewer selection', () => {
  beforeEach(() => {
    vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);
    window.localStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    useSettingsStore.getState().setThreadViewer('virtual');
  });

  test('renders the virtual list by default', () => {
    const { queryByTestId } = render(
      <MessageStream
        threadId="t1"
        status="idle"
        messages={makeMessages('done')}
        onSend={() => {}}
      />,
    );
    expect(queryByTestId('frozen-message-list-mock')).toBeNull();
  });

  test('renders the frozen list when threadViewer=frozen', () => {
    useSettingsStore.getState().setThreadViewer('frozen');
    const { getByTestId } = render(
      <MessageStream
        threadId="t1"
        status="idle"
        messages={makeMessages('done')}
        onSend={() => {}}
      />,
    );
    expect(getByTestId('frozen-message-list-mock')).toBeTruthy();
  });
});
