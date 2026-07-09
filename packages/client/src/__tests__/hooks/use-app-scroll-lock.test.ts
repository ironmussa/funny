import { renderHook } from '@testing-library/react';
import { describe, expect, test } from 'vitest';

import { APP_SCROLL_LOCK_CLASS, useAppScrollLock } from '@/hooks/use-app-scroll-lock';

describe('useAppScrollLock', () => {
  test('locks document scrolling while mounted', () => {
    const { unmount } = renderHook(() => useAppScrollLock());

    expect(document.documentElement).toHaveClass(APP_SCROLL_LOCK_CLASS);

    unmount();

    expect(document.documentElement).not.toHaveClass(APP_SCROLL_LOCK_CLASS);
  });

  test('keeps the lock until every mounted shell is gone', () => {
    const first = renderHook(() => useAppScrollLock());
    const second = renderHook(() => useAppScrollLock());

    first.unmount();

    expect(document.documentElement).toHaveClass(APP_SCROLL_LOCK_CLASS);

    second.unmount();

    expect(document.documentElement).not.toHaveClass(APP_SCROLL_LOCK_CLASS);
  });
});
