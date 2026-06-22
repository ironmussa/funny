import { act, render } from '@testing-library/react';
import { createRef, forwardRef, useEffect, useImperativeHandle } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { MessageStream, type MessageStreamHandle } from '@/components/thread/MessageStream';

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

vi.mock('motion/react', () => {
  const filterMotionProps = (props: any) =>
    Object.fromEntries(
      Object.entries(props).filter(
        ([k]) => !['initial', 'animate', 'transition', 'exit', 'layout'].includes(k),
      ),
    );
  const m = {
    div: ({ children, ...props }: any) => <div {...filterMotionProps(props)}>{children}</div>,
    span: ({ children, ...props }: any) => <span {...filterMotionProps(props)}>{children}</span>,
  };
  return {
    m,
    motion: m,
    useReducedMotion: () => true,
  };
});

const memoizedMessageListLifecycle = vi.hoisted(() => ({
  mounts: 0,
  unmounts: 0,
}));

vi.mock('@/components/thread/MemoizedMessageList', () => ({
  EMPTY_MESSAGES: [],
  MemoizedMessageList: forwardRef(function MockMemoizedMessageList(
    { messages }: { messages: any[] },
    ref,
  ) {
    useEffect(() => {
      memoizedMessageListLifecycle.mounts += 1;
      return () => {
        memoizedMessageListLifecycle.unmounts += 1;
      };
    }, []);

    useImperativeHandle(ref, () => ({
      expandToItem: () => {},
      hasHiddenItems: () => false,
      captureScrollAnchor: () => {},
      restoreScrollAnchor: () => {},
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
  }),
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
      viewport.scrollTop = 500;
      viewport.dispatchEvent(new Event('scroll'));
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
      viewport.scrollTop = 500;
      viewport.dispatchEvent(new Event('scroll'));
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
      viewport.scrollTop = 0;
      viewport.dispatchEvent(new Event('scroll'));
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
      viewport.scrollTop = 900;
      viewport.dispatchEvent(new Event('scroll'));
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
      viewport.scrollTop = 50;
      viewport.dispatchEvent(new Event('scroll'));
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
      viewport.scrollTop = 750;
      viewport.dispatchEvent(new Event('scroll'));
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
});
