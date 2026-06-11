import { render, waitFor } from '@testing-library/react';
import { useRef } from 'react';
import { describe, test, expect, vi } from 'vitest';

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

function Harness({ messages }: { messages: any[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={scrollRef} data-testid="viewport">
      <MemoizedMessageList
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

describe('MemoizedMessageList windowed rendering', () => {
  test('dispatches a scroll event when the window finishes expanding at the top', async () => {
    // 120 plain messages → 120 grouped items, INITIAL_WINDOW=30 → windowStart=90.
    // With scrollTop parked at 0 the rAF cascade auto-expands the window to 0.
    const { getByTestId } = render(<Harness messages={makeMessages(120)} />);
    const viewport = getByTestId('viewport');

    const onScroll = vi.fn();
    viewport.addEventListener('scroll', onScroll);

    // Regression: wheel-up at scrollTop=0 produces no scroll events, so once
    // the window fully expands the "load older messages" check in
    // MessageStream's scroll handler never re-runs and pagination stalls
    // until the user scrolls down and back up. The list must re-dispatch a
    // scroll event when windowStart reaches 0.
    await waitFor(() => expect(onScroll).toHaveBeenCalled());

    // Sanity: the window actually expanded to include every message.
    expect(viewport.querySelectorAll('[data-item-key]')).toHaveLength(120);
  });
});
