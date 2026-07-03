import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';

import { VirtualDiff } from '@/components/VirtualDiff';

const SIMPLE_DIFF = `diff --git a/src/example.ts b/src/example.ts
--- a/src/example.ts
+++ b/src/example.ts
@@ -1 +1 @@
-const value = 'old';
+const value = 'new';
`;

describe('VirtualDiff', () => {
  test('keeps visible scrollbars without global scroll masks', () => {
    render(<VirtualDiff unifiedDiff={SIMPLE_DIFF} viewMode="split" />);

    expect(screen.getByTestId('diff-scroll-area')).toHaveClass(
      'scroll-fade-none',
      'scrollbar-visible',
    );
    expect(screen.getByTestId('diff-scroll-area')).toHaveStyle({ scrollbarGutter: 'stable' });
    expect(screen.getByTestId('diff-h-scrollbar')).toHaveClass(
      'scroll-fade-none',
      'scrollbar-visible',
    );
    expect(screen.getByTestId('diff-scroll-frame')).toHaveStyle({
      '--diff-scrollbar-gutter': '12px',
    });
    expect(screen.queryByTestId('diff-fade-top')).not.toBeInTheDocument();
    expect(screen.queryByTestId('diff-fade-bottom')).not.toBeInTheDocument();
    expect(screen.queryByTestId('diff-fade-left')).not.toBeInTheDocument();
    expect(screen.queryByTestId('diff-fade-right')).not.toBeInTheDocument();
  });

  test('does not render vertical edge fades while scrolling', () => {
    render(<VirtualDiff unifiedDiff={SIMPLE_DIFF} viewMode="split" />);

    const scrollArea = screen.getByTestId('diff-scroll-area');
    Object.defineProperty(scrollArea, 'clientHeight', { configurable: true, value: 100 });
    Object.defineProperty(scrollArea, 'scrollHeight', { configurable: true, value: 220 });
    Object.defineProperty(scrollArea, 'scrollTop', {
      configurable: true,
      writable: true,
      value: 0,
    });

    fireEvent.scroll(scrollArea);
    expect(screen.queryByTestId('diff-fade-top')).not.toBeInTheDocument();
    expect(screen.queryByTestId('diff-fade-bottom')).not.toBeInTheDocument();

    scrollArea.scrollTop = 40;
    fireEvent.scroll(scrollArea);
    expect(screen.queryByTestId('diff-fade-top')).not.toBeInTheDocument();
    expect(screen.queryByTestId('diff-fade-bottom')).not.toBeInTheDocument();

    scrollArea.scrollTop = 120;
    fireEvent.scroll(scrollArea);
    expect(screen.queryByTestId('diff-fade-top')).not.toBeInTheDocument();
    expect(screen.queryByTestId('diff-fade-bottom')).not.toBeInTheDocument();
  });
});
