import { renderHook } from '@testing-library/react';
import type { NavigateFunction } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const mockUseNavigate = vi.hoisted(() => vi.fn());

vi.mock('react-router-dom', () => ({
  useNavigate: mockUseNavigate,
}));

import { useStableNavigate } from '@/hooks/use-stable-navigate';

describe('useStableNavigate', () => {
  beforeEach(() => {
    mockUseNavigate.mockReset();
  });

  test('keeps its identity while invoking the latest committed navigate function', () => {
    const initialNavigate = vi.fn() as NavigateFunction;
    const nextNavigate = vi.fn() as NavigateFunction;
    mockUseNavigate.mockReturnValue(initialNavigate);
    const { result, rerender } = renderHook(() => useStableNavigate());
    const stableNavigate = result.current;

    stableNavigate('/initial');
    expect(initialNavigate).toHaveBeenCalledWith('/initial');

    mockUseNavigate.mockReturnValue(nextNavigate);
    rerender();

    expect(result.current).toBe(stableNavigate);
    stableNavigate('/next');
    expect(nextNavigate).toHaveBeenCalledWith('/next');
  });
});
