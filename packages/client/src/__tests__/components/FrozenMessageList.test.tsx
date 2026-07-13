import { render } from '@testing-library/react';
import { createRef, useRef, type RefObject } from 'react';
import { afterEach, beforeEach, describe, test, expect, vi } from 'vitest';

import { FrozenMessageList } from '@/components/thread/FrozenMessageList';
import type { MemoizedMessageListHandle } from '@/components/thread/MemoizedMessageList.types';
import { makeLongThread } from '@/test-fixtures/long-thread-fixture';

import { mockT } from '../helpers/mock-i18n';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mockT, i18n: { language: 'en' } }),
  initReactI18next: { type: '3rdParty', init: () => {} },
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

function Harness({ handleRef }: { handleRef: RefObject<MemoizedMessageListHandle | null> }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const fx = makeLongThread({ messageCount: 10, seed: 5, toolCallRatio: 1 });
  return (
    <div ref={scrollRef} style={{ overflow: 'auto' }}>
      <FrozenMessageList
        ref={handleRef}
        messages={fx.messages}
        threadId={fx.threadId}
        threadStatus="idle"
        knownIds={new Set()}
        snapshotMap={new Map()}
        onSend={() => {}}
        onOpenLightbox={() => {}}
        scrollRef={scrollRef}
      />
    </div>
  );
}

class NoopIntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

describe('FrozenMessageList', () => {
  beforeEach(() => {
    // jsdom does not implement scrollIntoView.
    Element.prototype.scrollIntoView = vi.fn();
    // FrozenMessage (assistant rows) observes intersection to freeze offscreen.
    vi.stubGlobal('IntersectionObserver', NoopIntersectionObserver);
    vi.stubGlobal('requestAnimationFrame', () => 0);
    vi.stubGlobal('cancelAnimationFrame', () => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('mounts every row in normal flow (no absolute positioning)', () => {
    const handleRef = createRef<MemoizedMessageListHandle>();
    const { getByTestId, container } = render(<Harness handleRef={handleRef} />);

    const list = getByTestId('frozen-message-list');
    // In-flow container: flex column, not a positioned virtualizer.
    expect(list.style.position).toBe('');
    expect(list.style.display).toBe('flex');

    const rows = container.querySelectorAll('[data-virtual-row-key]');
    // 10 messages, each assistant with tool calls → at least one row per message.
    expect(rows.length).toBeGreaterThanOrEqual(10);
    // Non-user rows use content-visibility to skip offscreen work.
    rows.forEach((row) => {
      const el = row as HTMLElement;
      if (el.hasAttribute('data-section-msg-id')) return; // sticky user rows
      expect(el.style.contentVisibility).toBe('auto');
      expect(el.style.containIntrinsicSize).toContain('auto');
    });
  });

  test('expandToItem scrolls to a loaded row (§6.6)', () => {
    const handleRef = createRef<MemoizedMessageListHandle>();
    const { container } = render(<Harness handleRef={handleRef} />);

    // Any loaded row is mounted in the frozen list, so its data-item-key is
    // queryable and expandToItem can scroll straight to it (window loading for
    // unloaded targets is handled caller-side by store.loadMessagesUntil).
    const row = container.querySelector<HTMLElement>('[data-item-key]');
    expect(row).toBeTruthy();
    const key = row!.getAttribute('data-item-key')!;

    const spy = vi.spyOn(row!, 'scrollIntoView');
    handleRef.current!.expandToItem(key);
    expect(spy).toHaveBeenCalled();
  });

  test('keeps every loaded row text in the DOM for find-in-page (§6.8)', () => {
    const handleRef = createRef<MemoizedMessageListHandle>();
    const { container } = render(<Harness handleRef={handleRef} />);

    // The very first message (far from the bottom) must still be present in the
    // DOM — unlike the virtual viewer, which unmounts offscreen rows and hides
    // them from Ctrl+F. `(turn 0)` is the deterministic first user message.
    expect(container.textContent).toContain('(turn 0)');
  });

  test('stamps user rows with a section id and pins them sticky (§6.7)', () => {
    const handleRef = createRef<MemoizedMessageListHandle>();
    const { container } = render(<Harness handleRef={handleRef} />);
    const userRows = container.querySelectorAll<HTMLElement>('[data-section-msg-id]');
    expect(userRows.length).toBeGreaterThan(0);
    // Native sticky section headers: no per-frame JS, no content-visibility.
    userRows.forEach((row) => {
      expect(row.style.position).toBe('sticky');
      expect(row.style.top).toBe('0px');
      expect(row.style.contentVisibility).toBe('');
      // Opaque bg + own paint layer so the stuck header does not ghost/bleed
      // as content scrolls under it.
      expect(row.className).toContain('bg-background');
      expect(row.style.transform).toBe('translateZ(0)');
      // Each header must live inside its OWN section container so it is bounded
      // by that section and scrolls out with it — otherwise sibling stickies
      // pile up at top:0. The header is the section's first element child.
      const section = row.closest('[data-frozen-section]');
      expect(section).toBeTruthy();
      expect(section!.firstElementChild).toBe(row);
    });
  });

  test('groups rows into per-section containers headed by each user message (§6.7)', () => {
    const handleRef = createRef<MemoizedMessageListHandle>();
    const { container } = render(<Harness handleRef={handleRef} />);
    const sections = container.querySelectorAll('[data-frozen-section]');
    const userRows = container.querySelectorAll('[data-section-msg-id]');
    // One section per user message (the fixture starts with a user message, so
    // there is no headerless leading section).
    expect(sections.length).toBe(userRows.length);
  });

  test('exposes the message-list handle contract without throwing', () => {
    const handleRef = createRef<MemoizedMessageListHandle>();
    render(<Harness handleRef={handleRef} />);
    const handle = handleRef.current!;
    expect(handle).toBeTruthy();

    // No layout in jsdom → no visible anchor, but the calls must be safe.
    expect(handle.captureVisibleAnchor()).toBeNull();
    expect(() => handle.captureScrollAnchor()).not.toThrow();
    expect(handle.restoreScrollAnchor()).toBe(false);
    expect(handle.hasHiddenItems()).toBe(false);
    expect(() => handle.expandToItem('msg-0')).not.toThrow();
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });
});
