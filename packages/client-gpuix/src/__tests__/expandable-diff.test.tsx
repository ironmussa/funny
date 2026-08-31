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
    root.renderer.nativeSimulateClick(bounds![0]! + bounds![2]! / 2, bounds![1]! + bounds![3]! - 8);

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
