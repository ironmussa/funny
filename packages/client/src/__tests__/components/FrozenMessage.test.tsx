import { act, render } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { FrozenMessage } from '@/components/thread/FrozenMessage';

// Track live react-markdown mounts so we can prove the fiber tree is dropped
// when frozen (the memory goal), rather than relying on DOM text (the captured
// static HTML legitimately still contains the rendered markup).
const live = vi.hoisted(() => ({ mounts: 0 }));
vi.mock('@/components/thread/MessageContent', () => ({
  MessageContent: ({ content }: { content: string }) => {
    useEffect(() => {
      live.mounts += 1;
      return () => {
        live.mounts -= 1;
      };
    }, []);
    return <div data-testid="live-md">rendered: {content}</div>;
  },
}));

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

function setIntersecting(isIntersecting: boolean) {
  for (const o of observers) {
    for (const target of o.targets) {
      o.cb([{ target, isIntersecting } as IntersectionObserverEntry], o.self);
    }
  }
}

describe('FrozenMessage', () => {
  beforeEach(() => {
    observers.length = 0;
    vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);
    // Run rAF synchronously so the post-mount capture pass is deterministic.
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('renders live markdown initially', () => {
    live.mounts = 0;
    const { getByTestId } = render(<FrozenMessage content="hello world" />);
    const el = getByTestId('frozen-message');
    expect(el.dataset.frozen).toBe('false');
    expect(getByTestId('live-md').textContent).toContain('hello world');
    expect(live.mounts).toBe(1);
  });

  test('freezes offscreen: keeps the HTML but drops the react-markdown tree', () => {
    live.mounts = 0;
    const { getByTestId } = render(<FrozenMessage content="freeze me" />);
    expect(live.mounts).toBe(1);

    act(() => setIntersecting(false));

    const el = getByTestId('frozen-message');
    expect(el.dataset.frozen).toBe('true');
    // Text stays in the DOM (find-in-page reaches it), but the live subtree
    // unmounted — the memory win without losing Ctrl+F (§6.8).
    expect(el.innerHTML).toContain('freeze me');
    expect(el.textContent).toContain('freeze me');
    expect(live.mounts).toBe(0);
  });

  test('rehydrates to live React when scrolled back near', () => {
    live.mounts = 0;
    const { getByTestId } = render(<FrozenMessage content="round trip" />);

    act(() => setIntersecting(false));
    expect(getByTestId('frozen-message').dataset.frozen).toBe('true');
    expect(live.mounts).toBe(0);

    act(() => setIntersecting(true));
    expect(getByTestId('frozen-message').dataset.frozen).toBe('false');
    expect(live.mounts).toBe(1);
  });
});
