import { describe, expect, test } from 'bun:test';

import { createTestRoot, hasNativeTestRenderer } from '@gpuix/react/testing';

import { FileTree } from '../file-tree';
import { fileTreeWindowSizeForViewport } from '../file-tree-window';

describe('native file tree window', () => {
  const nativeTest = hasNativeTestRenderer ? test : test.skip;

  nativeTest('sizes the initial retained window from the viewport', () => {
    const files = Array.from({ length: 1_000 }, (_, index) => `src/file-${index}.ts`);
    const root = createTestRoot({ width: 400, height: 900 });
    root.render(<FileTree files={files} viewportHeight={900} />);

    expect(root.renderer.findByType('virtual-list')[0]?.children).toHaveLength(
      fileTreeWindowSizeForViewport(900, 1_001),
    );

    root.render(<FileTree files={files} viewportHeight={500} />);
    expect(root.renderer.findByType('virtual-list')[0]?.children).toHaveLength(
      fileTreeWindowSizeForViewport(500, 1_001),
    );
    root.unmount();
  });

  nativeTest('moves the bounded window across a large scroll jump', () => {
    const files = Array.from({ length: 1_000 }, (_, index) => `src/file-${index}.ts`);
    const root = createTestRoot({ width: 400, height: 500 });
    root.render(<FileTree files={files} viewportHeight={500} />);

    const list = root.renderer.findByType('virtual-list')[0];
    expect(list?.children).toHaveLength(fileTreeWindowSizeForViewport(500, 1_001));
    root.renderer.scrollToItem(list!.id, 901);
    root.renderer.flush();
    root.renderer.dispatchNativeEvents();
    root.renderer.flush();

    expect(root.renderer.findByTestId('file-tree-file-src/file-900.ts')).not.toBeNull();
    expect(root.renderer.findByTestId('file-tree-file-src/file-0.ts')).toBeNull();
    expect(root.renderer.findByType('virtual-list')[0]?.children.length).toBeLessThan(96);
    root.unmount();
  });

  nativeTest('returns to the first retained window when a filter changes', () => {
    const files = Array.from({ length: 1_000 }, (_, index) => `src/file-${index}.ts`);
    const root = createTestRoot({ width: 400, height: 500 });
    root.render(<FileTree files={files} viewportHeight={500} />);

    const list = root.renderer.findByType('virtual-list')[0];
    expect(list).toBeDefined();
    root.renderer.scrollToItem(list!.id, 500);
    root.renderer.flush();
    root.renderer.dispatchNativeEvents();
    root.renderer.flush();

    root.render(<FileTree files={files} query="file-1.ts" viewportHeight={500} />);
    root.render(<FileTree files={files} viewportHeight={500} />);

    expect(root.renderer.findByTestId('file-tree-folder-src')).not.toBeNull();
    expect(root.renderer.findByTestId('file-tree-file-src/file-0.ts')).not.toBeNull();
    root.unmount();
  });
});
