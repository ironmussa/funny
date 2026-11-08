import { describe, expect, test } from 'bun:test';

import { createTestRoot, hasNativeTestRenderer } from '@gpuix/react/testing';

import { ExpandableNativeDiff, NATIVE_DIFF_INITIAL_MAX_LINES, areMessageRowsEqual } from '../app';

function patchWithContextLines(count: number): string {
  const lines = Array.from({ length: count }, (_, index) => ` context ${index}`);
  return [
    'diff --git a/file.txt b/file.txt',
    '--- a/file.txt',
    '+++ b/file.txt',
    `@@ -1,${count} +1,${count} @@`,
    ...lines,
  ].join('\n');
}

describe('expandable native diff', () => {
  const nativeTest = hasNativeTestRenderer ? test : test.skip;

  nativeTest('does not offer expansion when the diff fits the initial limit', () => {
    const root = createTestRoot({ width: 1000, height: 1200 });
    root.render(<ExpandableNativeDiff patch={patchWithContextLines(3)} testId="diff" />);

    expect(root.renderer.findByTestId('diff')?.customProps?.maxLines).toBe(
      NATIVE_DIFF_INITIAL_MAX_LINES,
    );
    expect(
      root.renderer
        .getPaintedText()
        .some((text) => text.startsWith('Show ') && text.includes('more line')),
    ).toBeFalse();
    root.unmount();
  });

  nativeTest('expands a truncated diff through the native show-more row', () => {
    // The host caps the window at the display height (642px on CI runners), far
    // shorter than 120 diff rows, so scroll the Show more row into view first.
    const root = createTestRoot({ width: 1000, height: 5000 });
    root.render(
      <div testId="diff-scroller" style={{ width: '100%', height: '100%', overflowY: 'scroll' }}>
        <ExpandableNativeDiff
          patch={patchWithContextLines(NATIVE_DIFF_INITIAL_MAX_LINES + 5)}
          testId="diff"
        />
      </div>,
    );

    const truncated = root.renderer.findByTestId('diff');
    expect(truncated?.customProps?.maxLines).toBe(NATIVE_DIFF_INITIAL_MAX_LINES);
    const scroller = root.renderer.findByTestId('diff-scroller');
    const initial = root.renderer.getElementBounds(truncated!.id);
    expect(scroller).toBeDefined();
    expect(initial).not.toBeNull();
    root.renderer.scrollTo(scroller!.id, 0, -initial!.height);
    root.renderer.flush();
    expect(
      root.renderer
        .getPaintedText()
        .some((text) => text.startsWith('Show ') && text.includes('more line')),
    ).toBeTrue();

    // Probe upward from the bottom of what is visible: the Show more row is the
    // last row, and the line rows above it ignore the click.
    const isExpanded = () =>
      root.renderer.findByTestId('diff')?.customProps?.maxLines === undefined;
    const window = root.renderer.getWindowSize();
    const bounds = root.renderer.getElementBounds(truncated!.id)!;
    const bottom = Math.min(bounds.y + bounds.height, window.height) - 2;
    for (let y = bottom; y > Math.max(0, bottom - 200) && !isExpanded(); y -= 4) {
      root.renderer.nativeSimulateClick(bounds.x + bounds.width / 2, y);
    }
    if (!isExpanded()) {
      // Surfaces the geometry in CI logs: the native renderer is unavailable on Linux.
      console.error('show-more row not hit', JSON.stringify({ initial, bounds, window }));
    }

    expect(root.renderer.findByTestId('diff')?.customProps?.maxLines).toBeUndefined();
    expect(
      root.renderer
        .getPaintedText()
        .some((text) => text.startsWith('Show ') && text.includes('more line')),
    ).toBeFalse();
    root.unmount();
  });

  test('keeps unrelated message rows memoized while expansion stays local', () => {
    const message = {
      id: 'm1',
      threadId: 't1',
      role: 'assistant',
      content: patchWithContextLines(NATIVE_DIFF_INITIAL_MAX_LINES + 5),
    } as const;

    expect(
      areMessageRowsEqual(
        { message: message as never, messageId: message.id, richContent: true },
        { message: message as never, messageId: message.id, richContent: true },
      ),
    ).toBeTrue();
  });
});
