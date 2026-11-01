import { describe, expect, test } from 'bun:test';

import { createTestRoot, hasNativeTestRenderer } from '@gpuix/react/testing';

import { PointerCaptureScope } from '../pointer-capture';
import { GpuixUiProvider } from '../theme';
import { ScrollableVirtualList } from '../virtual-list-scrollbar';

describe('ScrollableVirtualList', () => {
  const nativeTest = hasNativeTestRenderer ? test : test.skip;

  nativeTest('scrolls the list when the scrollbar track is pressed and dragged', () => {
    const itemCount = 100;
    let listId: number | null = null;
    const root = createTestRoot({ width: 300, height: 200 });
    root.render(
      <GpuixUiProvider>
        <div style={{ width: 300, height: 200, display: 'flex', flexDirection: 'column' }}>
          <ScrollableVirtualList
            onListId={(id) => {
              listId = id;
            }}
            scrollbarTestId="list-scrollbar"
            itemCount={itemCount}
            estimatedItemHeight={20}
            style={{ flexGrow: 1, minHeight: 0, scrollbarColor: '#888888' }}
          >
            {Array.from({ length: itemCount }, (_, index) => (
              <div key={index} style={{ height: 20 }}>
                <text>{`Row ${index}`}</text>
              </div>
            ))}
          </ScrollableVirtualList>
        </div>
      </GpuixUiProvider>,
    );

    const track = root.renderer.findByTestId('list-scrollbar');
    const bounds = track ? root.renderer.getElementBounds(track.id) : null;
    expect(bounds).not.toBeNull();
    expect(listId).not.toBeNull();
    if (!bounds || listId === null) return;
    const x = bounds.x + bounds.width / 2;

    root.renderer.nativeSimulateMouseDown(x, bounds.y + bounds.height / 2, 0);
    const middle = root.renderer.getListScrollTop(listId)?.[0] ?? 0;
    expect(middle).toBeGreaterThan(30);
    expect(middle).toBeLessThan(70);

    // The track maps proportionally (100 rows over ~200px), so only its top edge is row 0.
    root.renderer.nativeSimulateMouseMove(x, bounds.y, 0);
    expect(root.renderer.getListScrollTop(listId)?.[0]).toBe(0);
    root.renderer.nativeSimulateMouseUp(x, bounds.y, 0);
    expect(root.renderer.findByTestId('list-scrollbar-capture')).toBeUndefined();
    root.unmount();
  });

  nativeTest('keeps dragging when the pointer crosses into a neighbouring panel', () => {
    const itemCount = 100;
    let listId: number | null = null;
    const root = createTestRoot({ width: 600, height: 200 });
    root.render(
      <GpuixUiProvider>
        <div style={{ width: 600, height: 200, display: 'flex', flexDirection: 'row' }}>
          <PointerCaptureScope>
            <div style={{ width: 300, height: 200, display: 'flex', flexDirection: 'column' }}>
              <ScrollableVirtualList
                onListId={(id) => {
                  listId = id;
                }}
                scrollbarTestId="list-scrollbar"
                itemCount={itemCount}
                estimatedItemHeight={20}
                style={{ flexGrow: 1, minHeight: 0 }}
              >
                {Array.from({ length: itemCount }, (_, index) => (
                  <div key={index} style={{ height: 20 }}>
                    <text>{`Row ${index}`}</text>
                  </div>
                ))}
              </ScrollableVirtualList>
            </div>
            <div testId="other-panel" style={{ width: 300, height: 200 }} />
          </PointerCaptureScope>
        </div>
      </GpuixUiProvider>,
    );

    const track = root.renderer.findByTestId('list-scrollbar');
    const bounds = track ? root.renderer.getElementBounds(track.id) : null;
    expect(bounds).not.toBeNull();
    if (!bounds || listId === null) return;

    root.renderer.nativeSimulateMouseDown(bounds.x + 4, bounds.y + 2, 0);
    // Into the neighbouring panel, near the bottom of the track's span.
    root.renderer.nativeSimulateMouseMove(450, bounds.y + bounds.height - 4, 0);

    expect(root.renderer.findByTestId('list-scrollbar-capture')).toBeDefined();
    expect(root.renderer.getListScrollTop(listId)?.[0]).toBeGreaterThan(80);
    root.renderer.nativeSimulateMouseUp(450, bounds.y + bounds.height - 4, 0);
    root.unmount();
  });
});
