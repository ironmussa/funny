import { renderHook } from '@testing-library/react';
import type { DockviewApi } from 'dockview-react';
import type { MutableRefObject } from 'react';
import { describe, expect, test, vi } from 'vitest';

import { useLeftPaneSync } from '@/components/dockview/use-left-pane-sync';

type EdgeGroupMock = {
  isCollapsed: ReturnType<typeof vi.fn>;
  expand: ReturnType<typeof vi.fn>;
  collapse: ReturnType<typeof vi.fn>;
};

function makeGroup(initiallyCollapsed: boolean): EdgeGroupMock {
  let collapsed = initiallyCollapsed;
  return {
    isCollapsed: vi.fn(() => collapsed),
    expand: vi.fn(() => {
      collapsed = false;
    }),
    collapse: vi.fn(() => {
      collapsed = true;
    }),
  };
}

function makeApi(group: EdgeGroupMock | null): DockviewApi {
  return {
    getEdgeGroup: vi.fn((side: string) => (side === 'left' ? group : null)),
  } as unknown as DockviewApi;
}

function makeApiRef(api: DockviewApi | null): MutableRefObject<DockviewApi | null> {
  return { current: api };
}

describe('useLeftPaneSync', () => {
  test('no-op when api ref is null', () => {
    const ref = makeApiRef(null);
    expect(() => renderHook(() => useLeftPaneSync(ref, true))).not.toThrow();
  });

  test('no-op when left edge group is missing', () => {
    const api = makeApi(null);
    const ref = makeApiRef(api);
    renderHook(() => useLeftPaneSync(ref, false));
    expect(api.getEdgeGroup).toHaveBeenCalledWith('left');
    // nothing to assert beyond "did not throw"
  });

  test('open + already expanded → does not call expand/collapse', () => {
    const group = makeGroup(false);
    const ref = makeApiRef(makeApi(group));
    renderHook(() => useLeftPaneSync(ref, true));
    expect(group.expand).not.toHaveBeenCalled();
    expect(group.collapse).not.toHaveBeenCalled();
  });

  test('closed on mount + group expanded → calls collapse once (cookie-restore case)', () => {
    const group = makeGroup(false);
    const ref = makeApiRef(makeApi(group));
    renderHook(() => useLeftPaneSync(ref, false));
    expect(group.collapse).toHaveBeenCalledTimes(1);
    expect(group.expand).not.toHaveBeenCalled();
  });

  test('open → close flip calls collapse', () => {
    const group = makeGroup(false);
    const ref = makeApiRef(makeApi(group));
    const { rerender } = renderHook(({ open }: { open: boolean }) => useLeftPaneSync(ref, open), {
      initialProps: { open: true },
    });
    expect(group.collapse).not.toHaveBeenCalled();
    rerender({ open: false });
    expect(group.collapse).toHaveBeenCalledTimes(1);
  });

  test('close → open flip calls expand', () => {
    const group = makeGroup(true);
    const ref = makeApiRef(makeApi(group));
    const { rerender } = renderHook(({ open }: { open: boolean }) => useLeftPaneSync(ref, open), {
      initialProps: { open: false },
    });
    // mount with open=false and already-collapsed group is a no-op
    expect(group.expand).not.toHaveBeenCalled();
    expect(group.collapse).not.toHaveBeenCalled();
    rerender({ open: true });
    expect(group.expand).toHaveBeenCalledTimes(1);
  });

  test('re-render with same value does not re-trigger', () => {
    const group = makeGroup(true);
    const ref = makeApiRef(makeApi(group));
    const { rerender } = renderHook(({ open }: { open: boolean }) => useLeftPaneSync(ref, open), {
      initialProps: { open: true },
    });
    expect(group.expand).toHaveBeenCalledTimes(1);
    rerender({ open: true });
    expect(group.expand).toHaveBeenCalledTimes(1);
  });
});
