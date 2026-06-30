import { render, screen } from '@testing-library/react';
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
  test('keeps visible scrollbars while rendering edge fade overlays', () => {
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
    expect(screen.getByTestId('diff-fade-top')).toHaveClass(
      'scroll-fade-edge',
      'scroll-fade-edge-top',
    );
    expect(screen.getByTestId('diff-fade-bottom')).toHaveClass(
      'scroll-fade-edge',
      'scroll-fade-edge-bottom',
    );
    expect(screen.queryByTestId('diff-fade-left')).not.toBeInTheDocument();
    expect(screen.queryByTestId('diff-fade-right')).not.toBeInTheDocument();
  });
});
