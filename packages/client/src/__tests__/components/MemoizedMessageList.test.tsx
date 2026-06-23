import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { useRef } from 'react';
import { beforeEach, describe, test, expect, vi } from 'vitest';

import { MemoizedMessageList } from '@/components/thread/MemoizedMessageList';

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
  UserMessageCard: ({ content, ...props }: any) => <div {...props}>{content}</div>,
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

const virtualizerMockState = vi.hoisted(() => ({
  start: undefined as number | undefined,
  visibleCount: 12,
  scrollOffset: 0,
  lastOptions: undefined as any,
  measureCalls: 0,
  scrollToIndexCalls: [] as { index: number; opts?: { align?: string } }[],
}));

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (opts: any) => {
    virtualizerMockState.lastOptions = opts;
    const count = opts.count ?? 0;
    const visibleCount = Math.min(count, virtualizerMockState.visibleCount);
    const start = virtualizerMockState.start ?? Math.max(0, count - visibleCount);
    const virtualItems = Array.from({ length: visibleCount }, (_, i) => {
      const index = start + i;
      const itemStart = index * 120;
      return {
        index,
        key: opts.getItemKey?.(index) ?? index,
        start: itemStart,
        end: itemStart + 120,
        size: 120,
        lane: 0,
      };
    });

    return {
      getVirtualItems: () => virtualItems,
      getTotalSize: () => count * 120,
      measureElement: () => {},
      scrollToIndex: (index: number, opts?: { align?: string }) => {
        virtualizerMockState.scrollToIndexCalls.push({ index, opts });
      },
      measure: () => {
        virtualizerMockState.measureCalls += 1;
      },
      scrollOffset: virtualizerMockState.scrollOffset,
    };
  },
}));

function makeMessages(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `m${i}`,
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `message ${i}`,
    timestamp: new Date(1700000000000 + i * 1000).toISOString(),
  }));
}

function makeMessagesWithToolCalls(toolCalls: any[]) {
  return [
    {
      id: 'u1',
      role: 'user',
      content: 'start',
      timestamp: '2026-01-01T00:00:00.000Z',
    },
    {
      id: 'a1',
      role: 'assistant',
      content: '',
      timestamp: '2026-01-01T00:00:01.000Z',
      toolCalls,
    },
  ];
}

function Harness({
  messages,
  leadingUserMessage,
  viewportHeight,
}: {
  messages: any[];
  leadingUserMessage?: any;
  viewportHeight?: number;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  if (!scrollRef.current && viewportHeight !== undefined) {
    const initialScrollElement = document.createElement('div');
    Object.defineProperty(initialScrollElement, 'clientHeight', {
      value: viewportHeight,
      configurable: true,
    });
    scrollRef.current = initialScrollElement;
  }
  return (
    <div
      ref={(node) => {
        if (!node) return;
        if (viewportHeight !== undefined) {
          Object.defineProperty(node, 'clientHeight', {
            value: viewportHeight,
            configurable: true,
          });
        }
        scrollRef.current = node;
      }}
      data-testid="viewport"
    >
      <MemoizedMessageList
        messages={messages}
        leadingUserMessage={leadingUserMessage}
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
  beforeEach(() => {
    virtualizerMockState.start = undefined;
    virtualizerMockState.visibleCount = 12;
    virtualizerMockState.scrollOffset = 0;
    virtualizerMockState.lastOptions = undefined;
    virtualizerMockState.measureCalls = 0;
    virtualizerMockState.scrollToIndexCalls = [];
  });

  test('keeps mounted item rows bounded for a long loaded thread', async () => {
    const { getByTestId } = render(<Harness messages={makeMessages(120)} />);
    const viewport = getByTestId('viewport');

    await waitFor(() =>
      expect(viewport.querySelectorAll('[data-item-key]').length).toBeGreaterThan(0),
    );
    expect(viewport.querySelectorAll('[data-item-key]').length).toBeLessThan(120);
  });

  test('does not count the sticky section context as a measured item row', async () => {
    const { getByTestId } = render(<Harness messages={makeMessages(121)} />);
    const viewport = getByTestId('viewport');

    await waitFor(() =>
      expect(viewport.querySelectorAll('[data-item-key]').length).toBeGreaterThan(0),
    );
    expect(viewport.querySelectorAll('[data-item-key]')).toHaveLength(12);
  });

  test('shows sticky section context when the owner row remains mounted only by overscan', async () => {
    virtualizerMockState.start = 0;
    virtualizerMockState.visibleCount = 12;
    virtualizerMockState.scrollOffset = 180;

    const { getByTestId } = render(<Harness messages={makeMessages(20)} />);
    const viewport = getByTestId('viewport');

    await waitFor(() => expect(viewport.querySelector('[data-item-key="m0"]')).toBeTruthy());

    expect(viewport.querySelectorAll('[data-testid="user-message-m0"]')).toHaveLength(2);
    expect(getByTestId('sticky-section-context').className).toContain('z-50');
    expect(viewport.querySelector('[data-virtual-row-key="m1"]')?.className).toContain('z-0');
  });

  test('does not show sticky section context while the user row is already visible at the top', async () => {
    virtualizerMockState.start = 0;
    virtualizerMockState.visibleCount = 1;
    virtualizerMockState.scrollOffset = 0;

    const { getByTestId, queryByTestId } = render(<Harness messages={makeMessages(4)} />);
    const viewport = getByTestId('viewport');

    await waitFor(() => expect(viewport.querySelector('[data-item-key="m0"]')).toBeTruthy());

    expect(queryByTestId('sticky-section-context')).toBeNull();
  });

  test('does not show sticky section context while the user row is partially visible', async () => {
    virtualizerMockState.start = 0;
    virtualizerMockState.visibleCount = 1;
    virtualizerMockState.scrollOffset = 4;

    const { getByTestId, queryByTestId } = render(<Harness messages={makeMessages(4)} />);
    const viewport = getByTestId('viewport');

    await waitFor(() => expect(viewport.querySelector('[data-item-key="m0"]')).toBeTruthy());

    expect(queryByTestId('sticky-section-context')).toBeNull();
  });

  test('does not show sticky section context when a stale virtual estimate says the visible user row has passed', async () => {
    virtualizerMockState.start = 0;
    virtualizerMockState.visibleCount = 2;
    virtualizerMockState.scrollOffset = 130;

    const rectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect');
    rectSpy.mockImplementation(function (this: Element) {
      if (this.getAttribute('data-testid') === 'viewport') {
        return { top: 0, bottom: 300, height: 300 } as DOMRect;
      }
      if (this instanceof HTMLElement && this.clientHeight === 300) {
        return { top: 0, bottom: 300, height: 300 } as DOMRect;
      }
      if (this.getAttribute('data-section-msg-id') === 'm0') {
        return { top: -80, bottom: 40, height: 120 } as DOMRect;
      }
      return { top: 0, bottom: 0, height: 0 } as DOMRect;
    });

    try {
      const { getByTestId, queryByTestId } = render(
        <Harness messages={makeMessages(4)} viewportHeight={300} />,
      );
      const viewport = getByTestId('viewport');

      await waitFor(() => expect(viewport.querySelector('[data-item-key="m0"]')).toBeTruthy());
      await act(async () => {});

      await waitFor(() => expect(queryByTestId('sticky-section-context')).toBeNull());
      expect(viewport.querySelectorAll('[data-testid="user-message-m0"]')).toHaveLength(1);
    } finally {
      rectSpy.mockRestore();
    }
  });

  test('shows sticky context for the first visible section when a later user row is visible', async () => {
    virtualizerMockState.start = 0;
    virtualizerMockState.visibleCount = 4;
    virtualizerMockState.scrollOffset = 130;

    const { getByTestId } = render(<Harness messages={makeMessages(6)} viewportHeight={240} />);
    const viewport = getByTestId('viewport');

    await waitFor(() => expect(viewport.querySelector('[data-item-key="m2"]')).toBeTruthy());

    expect(getByTestId('sticky-section-context')).toBeTruthy();
    expect(viewport.querySelectorAll('[data-testid="user-message-m0"]')).toHaveLength(2);
    expect(viewport.querySelector('[data-item-key="m2"]')).toBeTruthy();
  });

  test('uses leading user context when the owner row is outside the loaded window', async () => {
    virtualizerMockState.start = 0;
    virtualizerMockState.visibleCount = 2;

    const messages = [
      {
        id: 'a1',
        role: 'assistant',
        content: 'first response chunk',
        timestamp: '2026-01-01T00:00:01.000Z',
      },
      {
        id: 'a2',
        role: 'assistant',
        content: 'second response chunk',
        timestamp: '2026-01-01T00:00:02.000Z',
      },
    ];
    const leadingUserMessage = {
      id: 'u0',
      role: 'user',
      content: 'prompt outside the loaded window',
      timestamp: '2026-01-01T00:00:00.000Z',
    };

    const { getByTestId } = render(
      <Harness messages={messages} leadingUserMessage={leadingUserMessage} />,
    );
    const viewport = getByTestId('viewport');

    await waitFor(() => expect(getByTestId('sticky-section-context')).toBeTruthy());

    expect(viewport.querySelectorAll('[data-testid="user-message-u0"]')).toHaveLength(1);
    expect(viewport.querySelector('[data-item-key="u0"]')).toBeNull();
    expect(
      viewport.querySelector<HTMLElement>('[data-virtual-row-key="a1"]')?.style.transform,
    ).not.toBe('translateY(0px)');
  });

  test('clicking a sticky user card scrolls to the original virtual row when it is not mounted', async () => {
    virtualizerMockState.start = 1;
    virtualizerMockState.visibleCount = 1;
    virtualizerMockState.scrollOffset = 130;

    const { getByTestId } = render(<Harness messages={makeMessages(4)} />);

    await waitFor(() => expect(getByTestId('sticky-section-context')).toBeTruthy());

    fireEvent.click(getByTestId('user-message-m0'));

    expect(virtualizerMockState.scrollToIndexCalls).toEqual([
      { index: 0, opts: { align: 'start' } },
    ]);
  });

  test('does not use content-visibility placeholders for variable-height tool rows', async () => {
    const messages = makeMessagesWithToolCalls([
      {
        id: 'think-1',
        name: 'Think',
        input: { content: 'long reasoning content' },
        timestamp: '2026-01-01T00:00:01.000Z',
      },
    ]);
    const { getByTestId } = render(<Harness messages={messages} />);
    const viewport = getByTestId('viewport');

    await waitFor(() => expect(viewport.querySelector('[data-item-key="think-1"]')).toBeTruthy());

    const row = viewport.querySelector<HTMLElement>('[data-item-key="think-1"]')!;
    expect(row.style.contentVisibility).toBe('');
    expect(row.style.containIntrinsicSize).toBe('');
  });

  test('uses resize observer border-box height for virtual row measurements', async () => {
    const { getByTestId } = render(<Harness messages={makeMessages(2)} />);
    const viewport = getByTestId('viewport');

    await waitFor(() => expect(viewport.querySelector('[data-item-key="m0"]')).toBeTruthy());

    const row = document.createElement('div');
    row.dataset.virtualRowKey = 'm0';
    row.getBoundingClientRect = vi.fn(() => ({ height: 10 }) as DOMRect);

    const height = virtualizerMockState.lastOptions.measureElement(row, {
      borderBoxSize: [{ blockSize: 88 }],
    } as unknown as ResizeObserverEntry);

    expect(height).toBe(88);
    expect(row.getBoundingClientRect).not.toHaveBeenCalled();
    expect(virtualizerMockState.lastOptions.estimateSize(0)).toBe(88);
  });

  test('reserves observed row overflow beyond the virtualizer total estimate', async () => {
    virtualizerMockState.start = 0;
    virtualizerMockState.visibleCount = 2;

    const { getByTestId } = render(<Harness messages={makeMessages(2)} />);
    const viewport = getByTestId('viewport');

    await waitFor(() => expect(viewport.querySelector('[data-virtual-row-key="m0"]')).toBeTruthy());

    const row = viewport.querySelector<HTMLElement>('[data-virtual-row-key="m0"]')!;
    const virtualContainer = row.parentElement as HTMLElement;
    virtualContainer.getBoundingClientRect = vi.fn(
      () =>
        ({
          top: 0,
        }) as DOMRect,
    );
    row.getBoundingClientRect = vi.fn(
      () =>
        ({
          bottom: 300,
          height: 300,
        }) as DOMRect,
    );

    act(() => {
      virtualizerMockState.lastOptions.measureElement(row, {
        borderBoxSize: [{ blockSize: 300 }],
      } as unknown as ResizeObserverEntry);
    });

    await waitFor(() => expect(virtualContainer.style.height).toBe('300px'));
  });

  test('caps list height at the measured bottom of the final row', async () => {
    virtualizerMockState.start = 0;
    virtualizerMockState.visibleCount = 2;

    const { getByTestId } = render(<Harness messages={makeMessages(2)} />);
    const viewport = getByTestId('viewport');

    await waitFor(() => expect(viewport.querySelector('[data-virtual-row-key="m1"]')).toBeTruthy());

    const row = viewport.querySelector<HTMLElement>('[data-virtual-row-key="m1"]')!;
    const virtualContainer = row.parentElement as HTMLElement;
    virtualContainer.getBoundingClientRect = vi.fn(
      () =>
        ({
          top: 0,
        }) as DOMRect,
    );
    row.getBoundingClientRect = vi.fn(
      () =>
        ({
          bottom: 160,
          height: 40,
        }) as DOMRect,
    );

    act(() => {
      virtualizerMockState.lastOptions.measureElement(row, {
        borderBoxSize: [{ blockSize: 40 }],
      } as unknown as ResizeObserverEntry);
    });

    await waitFor(() => expect(virtualContainer.style.height).toBe('160px'));
  });

  test('uses a conservative initial estimate for collapsed user message cards', async () => {
    const messages = [
      {
        id: 'u1',
        role: 'user',
        content: Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n'),
        timestamp: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'a1',
        role: 'assistant',
        content: 'response',
        timestamp: '2026-01-01T00:00:01.000Z',
      },
    ];

    const { getByTestId } = render(<Harness messages={messages} />);
    const viewport = getByTestId('viewport');

    await waitFor(() => expect(viewport.querySelector('[data-item-key="u1"]')).toBeTruthy());

    expect(virtualizerMockState.lastOptions.estimateSize(0)).toBeGreaterThan(120);
  });

  test('does not use content-visibility placeholders for variable-height tool runs', async () => {
    const messages = makeMessagesWithToolCalls([
      {
        id: 'think-1',
        name: 'Think',
        input: { content: 'first tool' },
        timestamp: '2026-01-01T00:00:01.000Z',
      },
      {
        id: 'bash-1',
        name: 'Bash',
        input: { command: 'bun test' },
        output: 'a\nb\nc',
        timestamp: '2026-01-01T00:00:02.000Z',
      },
    ]);
    const { getByTestId } = render(<Harness messages={messages} />);
    const viewport = getByTestId('viewport');

    await waitFor(() => expect(viewport.querySelector('[data-item-key="think-1"]')).toBeTruthy());

    const row = viewport.querySelector<HTMLElement>('[data-item-key="think-1"]')!;
    expect(row.style.contentVisibility).toBe('');
    expect(row.style.containIntrinsicSize).toBe('');
  });
});
