import { act, render, waitFor } from '@testing-library/react';
import { useEffect, useRef } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import {
  MessageStream,
  type MessageStreamHandle,
  type MessageStreamProps,
} from '@/components/thread/MessageStream';

import { mockT } from '../helpers/mock-i18n';

const resizeObservers: Array<{ callback: ResizeObserverCallback }> = [];
const rafCallbacks: FrameRequestCallback[] = [];
let listScrollToBottom: ReturnType<typeof vi.fn>;

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
  };
  return {
    m,
    useReducedMotion: () => false,
  };
});

vi.mock('@/components/ui/loading-state', () => ({
  LoadingState: () => null,
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

vi.mock('@/lib/thread-utils', () => ({
  timeAgo: () => 'now',
}));

vi.mock('@/stores/thread-selectors', () => ({
  selectLastMessage: (thread: { messages?: any[] }) => thread.messages?.at(-1) ?? null,
  selectFirstMessage: (thread: { messages?: any[] }) => thread.messages?.[0] ?? null,
}));

vi.mock('@/components/thread/MemoizedMessageList', async () => {
  const React = await import('react');
  return {
    EMPTY_MESSAGES: [],
    MemoizedMessageList: React.forwardRef(function MockMemoizedMessageList(_props: any, ref: any) {
      React.useImperativeHandle(
        ref,
        () => ({
          scrollToBottom: listScrollToBottom,
          expandToItem: vi.fn(),
          hasHiddenItems: () => false,
          captureScrollAnchor: vi.fn(),
          restoreScrollAnchor: vi.fn(),
        }),
        [],
      );
      return <div data-testid="message-list" style={{ height: 100 }} />;
    }),
  };
});

function flushRafFrame() {
  const callbacks = rafCallbacks.splice(0);
  callbacks.forEach((cb, index) => cb(index));
}

function Harness({
  props,
  onReady,
}: {
  props: Partial<MessageStreamProps>;
  onReady: (handle: MessageStreamHandle | null) => void;
}) {
  const ref = useRef<MessageStreamHandle>(null);

  useEffect(() => {
    onReady(ref.current);
  }, [onReady]);

  return (
    <MessageStream
      ref={ref}
      threadId="t1"
      status="idle"
      messages={[
        {
          id: 'm1',
          role: 'assistant',
          content: 'hello',
          timestamp: new Date(1700000000000).toISOString(),
        },
      ]}
      onSend={() => {}}
      {...props}
    />
  );
}

describe('MessageStream sticky-bottom scheduling', () => {
  beforeEach(() => {
    resizeObservers.length = 0;
    rafCallbacks.length = 0;
    listScrollToBottom = vi.fn();

    vi.stubGlobal(
      'ResizeObserver',
      class ResizeObserver {
        callback: ResizeObserverCallback;

        constructor(callback: ResizeObserverCallback) {
          this.callback = callback;
          resizeObservers.push(this);
        }

        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );

    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      rafCallbacks.push(callback);
      return rafCallbacks.length;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
  });

  test('does not resync the virtualizer for content-only bottom growth', async () => {
    let handle: MessageStreamHandle | null = null;
    render(<Harness props={{}} onReady={(next) => (handle = next)} />);

    await waitFor(() => expect(handle?.scrollViewport).not.toBeNull());
    const viewport = handle!.scrollViewport!;

    let scrollTop = 500;
    let scrollTopWrites = 0;
    Object.defineProperties(viewport, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 500 },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => {
          scrollTop = value;
          scrollTopWrites += 1;
        },
      },
    });

    act(() => {
      flushRafFrame();
      flushRafFrame();
    });
    listScrollToBottom.mockClear();
    scrollTopWrites = 0;
    scrollTop = 450;

    act(() => {
      resizeObservers.forEach(({ callback }) => callback([], {} as ResizeObserver));
      resizeObservers.forEach(({ callback }) => callback([], {} as ResizeObserver));
      resizeObservers.forEach(({ callback }) => callback([], {} as ResizeObserver));
      flushRafFrame();
      flushRafFrame();
    });

    expect(listScrollToBottom).not.toHaveBeenCalled();
    expect(scrollTopWrites).toBe(1);
    expect(scrollTop).toBe(500);
  });
});
