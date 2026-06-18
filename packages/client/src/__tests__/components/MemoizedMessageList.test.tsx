import { render, waitFor } from '@testing-library/react';
import { useEffect, useRef } from 'react';
import { describe, test, expect, vi } from 'vitest';

import {
  MemoizedMessageList,
  type MemoizedMessageListHandle,
} from '@/components/thread/MemoizedMessageList';

import { mockT } from '../helpers/mock-i18n';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: mockT,
    i18n: { language: 'en' },
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

vi.mock('@/hooks/use-minute-tick', () => ({
  useMinuteTick: () => {},
}));

const virtualizerMock = vi.hoisted(() => ({
  visibleStart: 0,
  visibleCount: 30,
  scrollOffset: 0,
  scrollToIndex: vi.fn(),
  measureElement: vi.fn(),
  measure: vi.fn(),
  lastOptions: null as any,
}));

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (opts: any) => {
    virtualizerMock.lastOptions = opts;
    const start = Math.min(virtualizerMock.visibleStart, Math.max(0, opts.count - 1));
    const count = Math.max(0, Math.min(virtualizerMock.visibleCount, opts.count - start));
    const virtualItems = Array.from({ length: count }, (_, offset) => {
      const index = start + offset;
      return {
        index,
        key: opts.getItemKey(index),
        start: index * 100 + (opts.scrollMargin ?? 0),
        size: 100,
        end: (index + 1) * 100 + (opts.scrollMargin ?? 0),
      };
    });

    return {
      getVirtualItems: () => virtualItems,
      getTotalSize: () => opts.count * 100,
      measureElement: virtualizerMock.measureElement,
      scrollToIndex: virtualizerMock.scrollToIndex,
      measure: virtualizerMock.measure,
      scrollOffset: virtualizerMock.scrollOffset,
      options: { scrollMargin: opts.scrollMargin ?? 0 },
    };
  },
}));

vi.mock('@/hooks/use-pretext', () => ({
  getCachedPrepared: () => null,
  isPretextReady: () => false,
  layoutSync: () => ({ height: 0 }),
  prepareBatch: () => {},
  makeProseFont: () => '14px sans-serif',
  ensurePretextLoaded: () => new Promise(() => {}),
}));

vi.mock('@/stores/settings-store', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    useSettingsStore: Object.assign(
      (selector?: (s: { fontSize: string }) => unknown) =>
        selector ? selector({ fontSize: 'default' }) : { fontSize: 'default' },
      { getState: () => ({ fontSize: 'default', toolPermissions: {} }) },
    ),
  };
});

vi.mock('@/components/ToolCallCard', () => ({
  ToolCallCard: ({ name }: any) => <div data-testid="tool-call-card">{name}</div>,
}));

vi.mock('@/components/ToolCallGroup', () => ({
  ToolCallGroup: ({ name }: any) => <div data-testid="tool-call-group">{name}</div>,
}));

vi.mock('@/components/thread/MessageContent', () => ({
  MessageContent: ({ content }: any) => <div>{content}</div>,
  CopyButton: () => null,
}));

vi.mock('@/components/thread/UserMessageCard', () => ({
  UserMessageCard: ({ content }: any) => <div>{content}</div>,
}));

vi.mock('@/components/thread/GitEventCard', () => ({
  GitEventCard: () => null,
}));

vi.mock('@/components/thread/CompactionEventCard', () => ({
  CompactionEventCard: () => null,
}));

vi.mock('@/components/thread/WorkflowEventGroup', () => ({
  WorkflowEventGroup: () => null,
}));

function makeMessages(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `m${i}`,
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `message ${i}`,
    timestamp: new Date(1700000000000 + i * 1000).toISOString(),
  }));
}

function makeMessagesWithToolCall() {
  return [
    {
      id: 'u1',
      role: 'user',
      content: 'change a file',
      timestamp: new Date(1700000000000).toISOString(),
    },
    {
      id: 'a1',
      role: 'assistant',
      content: '',
      timestamp: new Date(1700000001000).toISOString(),
      toolCalls: [
        {
          id: 'tc1',
          name: 'Edit',
          input: '{}',
          timestamp: new Date(1700000002000).toISOString(),
        },
      ],
    },
    {
      id: 'a2',
      role: 'assistant',
      content: 'done',
      timestamp: new Date(1700000003000).toISOString(),
    },
  ];
}

function makeMessagesWithLargeWrite() {
  return [
    {
      id: 'u1',
      role: 'user',
      content: 'write a file',
      timestamp: new Date(1700000000000).toISOString(),
    },
    {
      id: 'a1',
      role: 'assistant',
      content: '',
      timestamp: new Date(1700000001000).toISOString(),
      toolCalls: [
        {
          id: 'tc1',
          name: 'Write',
          input: JSON.stringify({
            file_path: '/tmp/example.ts',
            content: Array.from({ length: 30 }, (_, i) => `const line${i} = ${i};`).join('\n'),
          }),
          timestamp: new Date(1700000002000).toISOString(),
        },
      ],
    },
    {
      id: 'a2',
      role: 'assistant',
      content: 'done',
      timestamp: new Date(1700000003000).toISOString(),
    },
  ];
}

function Harness({
  messages,
  onReady,
}: {
  messages: any[];
  onReady?: (handle: MemoizedMessageListHandle | null) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<MemoizedMessageListHandle>(null);

  useEffect(() => {
    onReady?.(listRef.current);
  }, [onReady]);

  return (
    <div ref={scrollRef} data-testid="viewport">
      <MemoizedMessageList
        ref={listRef}
        messages={messages}
        threadId="t1"
        knownIds={new Set()}
        prefersReducedMotion={true}
        snapshotMap={new Map()}
        onSend={() => {}}
        onOpenLightbox={() => {}}
        scrollRef={scrollRef}
      />
    </div>
  );
}

describe('MemoizedMessageList virtualization', () => {
  test('mounts only the virtualizer range for a long loaded thread', () => {
    virtualizerMock.visibleStart = 90;
    virtualizerMock.visibleCount = 30;
    virtualizerMock.scrollOffset = 0;

    const { getByTestId } = render(<Harness messages={makeMessages(120)} />);
    const viewport = getByTestId('viewport');

    expect(viewport.querySelectorAll('[data-item-key]')).toHaveLength(30);
    expect(viewport.querySelector('[data-item-key="m0"]')).toBeNull();
    expect(viewport.querySelector('[data-item-key="m119"]')).not.toBeNull();
  });

  test('dispatches a scroll event when the virtual range reaches the top', async () => {
    virtualizerMock.visibleStart = 90;
    virtualizerMock.visibleCount = 30;
    virtualizerMock.scrollOffset = 0;

    const { getByTestId, rerender } = render(<Harness messages={makeMessages(120)} />);
    const viewport = getByTestId('viewport');

    const onScroll = vi.fn();
    viewport.addEventListener('scroll', onScroll);

    virtualizerMock.visibleStart = 0;
    rerender(<Harness messages={makeMessages(120)} />);

    await waitFor(() => expect(onScroll).toHaveBeenCalled());
  });

  test('expandToItem scrolls the virtualizer to the grouped item index', async () => {
    virtualizerMock.visibleStart = 90;
    virtualizerMock.visibleCount = 30;
    virtualizerMock.scrollOffset = 0;
    virtualizerMock.scrollToIndex.mockClear();

    let handle: MemoizedMessageListHandle | null = null;
    render(<Harness messages={makeMessages(120)} onReady={(next) => (handle = next)} />);

    await waitFor(() => expect(handle).not.toBeNull());
    handle!.expandToItem('m10');

    expect(virtualizerMock.scrollToIndex).toHaveBeenCalledWith(10, {
      align: 'center',
    });
    expect(handle!.hasHiddenItems()).toBe(true);
  });

  test('scrollToBottom scrolls the virtualizer to the last grouped item', async () => {
    virtualizerMock.visibleStart = 90;
    virtualizerMock.visibleCount = 30;
    virtualizerMock.scrollOffset = 0;
    virtualizerMock.scrollToIndex.mockClear();

    let handle: MemoizedMessageListHandle | null = null;
    render(<Harness messages={makeMessages(120)} onReady={(next) => (handle = next)} />);

    await waitFor(() => expect(handle).not.toBeNull());
    handle!.scrollToBottom();

    expect(virtualizerMock.scrollToIndex).toHaveBeenCalledWith(119, {
      align: 'end',
    });
  });

  test('keeps the owning user card sticky when overscan includes it above the viewport', () => {
    virtualizerMock.visibleStart = 90;
    virtualizerMock.visibleCount = 10;
    virtualizerMock.scrollOffset = 9100;

    const { getByTestId } = render(<Harness messages={makeMessages(120)} />);
    const viewport = getByTestId('viewport');

    expect(viewport.querySelector('[data-sticky-section-context="m90"]')).not.toBeNull();
  });

  test('does not make virtualized user rows sticky', () => {
    virtualizerMock.visibleStart = 88;
    virtualizerMock.visibleCount = 10;
    virtualizerMock.scrollOffset = 9100;

    const { getByTestId } = render(<Harness messages={makeMessages(120)} />);
    const viewport = getByTestId('viewport');

    const realUserRows = Array.from(
      viewport.querySelectorAll('[data-index] [data-user-msg][data-item-key]'),
    );
    expect(realUserRows.length).toBeGreaterThan(0);
    expect(realUserRows.some((row) => row.classList.contains('sticky'))).toBe(false);
  });

  test('does not use content-visibility inside measured virtual rows', () => {
    virtualizerMock.visibleStart = 0;
    virtualizerMock.visibleCount = 10;
    virtualizerMock.scrollOffset = 0;

    const { getByTestId } = render(<Harness messages={makeMessagesWithToolCall()} />);
    const viewport = getByTestId('viewport');
    const toolRow = viewport.querySelector<HTMLElement>('[data-item-key="tc1"]');

    expect(toolRow).not.toBeNull();
    expect(toolRow!.style.contentVisibility).toBe('');
    expect(toolRow!.style.containIntrinsicSize).toBe('');
  });

  test('estimates expanded tool cards from their content instead of a fixed row height', () => {
    virtualizerMock.visibleStart = 0;
    virtualizerMock.visibleCount = 10;
    virtualizerMock.scrollOffset = 0;

    render(<Harness messages={makeMessagesWithLargeWrite()} />);

    expect(virtualizerMock.lastOptions).not.toBeNull();
    expect(virtualizerMock.lastOptions.estimateSize(1)).toBeGreaterThan(300);
  });

  test('smoothly hands sticky context from the previous user card to the next one', () => {
    virtualizerMock.visibleStart = 88;
    virtualizerMock.visibleCount = 10;
    virtualizerMock.scrollOffset = 9024;

    const { getByTestId, rerender } = render(<Harness messages={makeMessages(120)} />);
    const viewport = getByTestId('viewport');

    expect(viewport.querySelector('[data-sticky-section-context="m88"]')).not.toBeNull();

    virtualizerMock.scrollOffset = 9080;
    rerender(<Harness messages={makeMessages(120)} />);

    expect(viewport.querySelector('[data-sticky-section-context="m90"]')).not.toBeNull();
    expect(viewport.querySelector('[data-sticky-section-context][data-section-msg-id]')).toBeNull();
  });
});
