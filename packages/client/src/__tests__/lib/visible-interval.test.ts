import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { setVisibleInterval } from '@/lib/visible-interval';

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('setVisibleInterval', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setVisibility('visible');
  });
  afterEach(() => {
    vi.useRealTimers();
    setVisibility('visible');
  });

  test('polls while visible and stops while the tab is hidden', () => {
    const tick = vi.fn();
    const stop = setVisibleInterval(tick, 1000);

    vi.advanceTimersByTime(3000);
    expect(tick).toHaveBeenCalledTimes(3);

    setVisibility('hidden');
    vi.advanceTimersByTime(10_000);
    expect(tick).toHaveBeenCalledTimes(3);
    stop();
  });

  test('refreshes at once when the tab becomes visible, then resumes', () => {
    const tick = vi.fn();
    const stop = setVisibleInterval(tick, 1000);
    setVisibility('hidden');
    vi.advanceTimersByTime(5000);

    setVisibility('visible');
    expect(tick).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(tick).toHaveBeenCalledTimes(2);
    stop();
  });

  test('starts paused in a hidden tab and cleans up every listener', () => {
    setVisibility('hidden');
    const tick = vi.fn();
    const stop = setVisibleInterval(tick, 1000);
    vi.advanceTimersByTime(5000);
    expect(tick).not.toHaveBeenCalled();

    stop();
    setVisibility('visible');
    vi.advanceTimersByTime(5000);
    expect(tick).not.toHaveBeenCalled();
  });
});
