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
    const root = createTestRoot({ width: 1000, height: 5000 });
    root.render(
      <ExpandableNativeDiff
        patch={patchWithContextLines(NATIVE_DIFF_INITIAL_MAX_LINES + 5)}
        testId="diff"
      />,
    );

    const truncated = root.renderer.findByTestId('diff');
    expect(truncated?.customProps?.maxLines).toBe(NATIVE_DIFF_INITIAL_MAX_LINES);
    expect(
      root.renderer
        .getPaintedText()
        .some((text) => text.startsWith('Show ') && text.includes('more line')),
    ).toBeTrue();
    const bounds = root.renderer.getElementBounds(truncated!.id);
    expect(bounds).not.toBeNull();
    // The Show more row follows the last painted line, but the element can be
    // taller than its rows, so a fixed offset from its bottom edge may land in
    // empty space. Probe upward through real GPUI hit testing, within the
    // window, until the row is hit; other rows ignore the click.
    const isExpanded = () =>
      root.renderer.findByTestId('diff')?.customProps?.maxLines === undefined;
    const window = root.renderer.getWindowSize();
    const bottom = Math.min(bounds!.y + bounds!.height, window.height) - 2;
    const top = Math.max(bounds!.y, bottom - 400);
    for (let y = bottom; y > top && !isExpanded(); y -= 4) {
      root.renderer.nativeSimulateClick(bounds!.x + bounds!.width / 2, y);
    }
    if (!isExpanded()) {
      // Surfaces the geometry in CI logs: the native renderer is unavailable on Linux.
      console.error('show-more row not hit', JSON.stringify({ bounds, window }));
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
