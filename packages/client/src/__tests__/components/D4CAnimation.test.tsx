import { render } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { D4CAnimation } from '@/components/D4CAnimation';

describe('D4CAnimation', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test('uses CSS animation without JS timers', () => {
    vi.useFakeTimers();
    const { container } = render(<D4CAnimation />);
    const frames = container.querySelectorAll('.d4c-frame');

    expect(frames).toHaveLength(4);
    expect(container).toHaveTextContent('🐇');
    expect(container).toHaveTextContent('🐰');
    expect(vi.getTimerCount()).toBe(0);
  });
});
