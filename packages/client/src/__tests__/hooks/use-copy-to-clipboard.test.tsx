import { act, renderHook } from '@testing-library/react';
import { toast } from 'sonner';
import { afterEach, expect, test, vi } from 'vitest';

import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback: string) => fallback }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

function clipboard(writeText: ReturnType<typeof vi.fn>) {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
}

test('waits for clipboard success, resets feedback, and clears the timer on unmount', async () => {
  vi.useFakeTimers();
  let resolve!: () => void;
  clipboard(
    vi.fn(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    ),
  );
  const { result, unmount } = renderHook(() => useCopyToClipboard());
  let pending!: Promise<boolean>;
  act(() => {
    pending = result.current[1]('hello');
  });
  expect(result.current[0]).toBe(false);
  expect(toast.success).not.toHaveBeenCalled();
  await act(async () => {
    resolve();
    await pending;
  });
  expect(result.current[0]).toBe(true);
  expect(toast.success).toHaveBeenCalledOnce();
  act(() => {
    vi.advanceTimersByTime(2000);
  });
  expect(result.current[0]).toBe(false);
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});

test('reports clipboard errors without success feedback', async () => {
  clipboard(vi.fn().mockRejectedValue(new Error('Denied')));
  const { result } = renderHook(() => useCopyToClipboard());
  await act(async () => {
    expect(await result.current[1]('hello')).toBe(false);
  });
  expect(result.current[0]).toBe(false);
  expect(toast.success).not.toHaveBeenCalled();
  expect(toast.error).toHaveBeenCalledOnce();
});
