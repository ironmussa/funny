import { describe, expect, test } from 'bun:test';

import { renderHook, waitFor } from '@testing-library/react';

import { useAsyncHighlight } from '@/hooks/use-async-highlight';

describe('useAsyncHighlight', () => {
  test('highlights the code once its grammar is ready', async () => {
    const { result } = renderHook(() => useAsyncHighlight('a < b', 'plaintext'));
    expect(result.current).toBeNull();
    await waitFor(() => expect(result.current).toBe('a &lt; b'));
  });

  test('keeps the old highlight for changed code, and drops it with the code', async () => {
    const { result, rerender } = renderHook(
      ({ code }: { code: string | null }) => useAsyncHighlight(code, 'plaintext'),
      { initialProps: { code: 'one' as string | null } },
    );
    await waitFor(() => expect(result.current).toBe('one'));

    rerender({ code: 'two' });
    expect(result.current).toBe('one');
    await waitFor(() => expect(result.current).toBe('two'));

    rerender({ code: null });
    expect(result.current).toBeNull();
  });
});
