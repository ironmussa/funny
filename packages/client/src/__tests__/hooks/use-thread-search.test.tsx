import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MessageStreamHandle } from '@/components/thread/MessageStream';
import { useThreadSearchState } from '@/hooks/use-thread-search';

vi.mock('@/stores/thread-store', () => ({ useThreadStore: { getState: vi.fn() } }));

let viewport: HTMLDivElement;
beforeEach(() => {
  viewport = document.createElement('div');
  viewport.innerHTML =
    '<div data-item-key="one">Con respaldo disponible</div><div data-item-key="two">Otro respaldo</div>';
  document.body.append(viewport);
  vi.stubGlobal('CSS', { escape: (value: string) => value });
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  viewport.remove();
  vi.unstubAllGlobals();
});

function setup() {
  const streamRef = {
    current: { scrollViewport: viewport, expandToItem: vi.fn() } as unknown as MessageStreamHandle,
  };
  return renderHook(() => useThreadSearchState(streamRef, 'thread'));
}

describe('thread search highlight lifecycle', () => {
  it('keeps visible matches highlighted while cycling and moves only the active mark', () => {
    const { result } = setup();
    act(() => {
      result.current.handleSearchNavigate('one', 'respaldo', 0);
    });
    expect(viewport.querySelectorAll('mark[data-search-hl]')).toHaveLength(2);
    act(() => {
      result.current.handleSearchNavigate('two', 'respaldo', 0);
    });
    expect(viewport.querySelectorAll('mark[data-search-hl]')).toHaveLength(2);
    expect(viewport.querySelectorAll('mark[data-search-current]')).toHaveLength(1);
    expect(viewport.querySelector('[data-item-key="two"] mark')).toHaveAttribute(
      'data-search-current',
    );
  });

  it('restores marks after async rendering and highlights newly mounted messages', async () => {
    const { result } = setup();
    act(() => {
      result.current.handleSearchNavigate('one', 'respaldo', 0);
    });
    viewport.firstElementChild!.innerHTML = '<span>Con respaldo disponible</span>';
    const item = document.createElement('div');
    item.dataset.itemKey = 'three';
    item.textContent = 'Más respaldo';
    viewport.append(item);
    await waitFor(() => expect(viewport.querySelectorAll('mark[data-search-hl]')).toHaveLength(3));
    expect(viewport.querySelector('[data-item-key="one"] mark')).toHaveAttribute(
      'data-search-current',
    );
    expect(viewport.querySelector('mark mark')).toBeNull();
  });

  it('highlights mounted messages even when the active result leaves the window', async () => {
    const { result } = setup();
    act(() => {
      result.current.handleSearchNavigate('one', 'respaldo', 0);
    });
    viewport.firstElementChild!.remove();
    viewport.insertAdjacentHTML('beforeend', '<div data-item-key="three">Más respaldo</div>');
    await waitFor(() => expect(viewport.querySelectorAll('mark[data-search-hl]')).toHaveLength(2));
  });

  it('clears old queries and disconnects on close', async () => {
    const { result } = setup();
    act(() => {
      result.current.handleSearchNavigate('one', 'respaldo', 0);
    });
    act(() => {
      result.current.handleSearchNavigate('two', 'Otro', 0);
    });
    expect(viewport.querySelectorAll('mark')).toHaveLength(1);
    expect(viewport.querySelector('mark')).toHaveTextContent('Otro');
    act(() => {
      result.current.handleSearchClose();
    });
    viewport.firstElementChild!.textContent = 'Otro respaldo';
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(viewport.querySelector('mark')).toBeNull();
  });
});
