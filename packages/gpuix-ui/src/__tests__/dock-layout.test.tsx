import { describe, expect, test } from 'bun:test';

import { createTestRoot, hasNativeTestRenderer } from '@gpuix/react/testing';

import { Button } from '../button';
import { DockLayout } from '../dock-layout';
import type { DockLayoutState } from '../dock-layout-model';
import { GpuixUiProvider } from '../theme';

describe('DockLayout', () => {
  const nativeTest = hasNativeTestRenderer ? test : test.skip;

  nativeTest('resizes adjacent docks through the native separator drag', () => {
    const changes: DockLayoutState[] = [];
    const root = createTestRoot({ width: 800, height: 400 });
    root.render(
      <GpuixUiProvider>
        <DockLayout.Root onValueChange={(value) => changes.push(value)}>
          <DockLayout.Panel id="navigation" defaultSize={240} minSize={180}>
            <DockLayout.Handle testId="navigation-handle">
              <text>Navigation</text>
            </DockLayout.Handle>
          </DockLayout.Panel>
          <DockLayout.Panel id="conversation" minSize={320}>
            <DockLayout.Handle testId="conversation-handle">
              <text>Conversation</text>
            </DockLayout.Handle>
          </DockLayout.Panel>
        </DockLayout.Root>
      </GpuixUiProvider>,
    );

    const separator = root.renderer.findByTestId('dock-separator-navigation-conversation');
    const bounds = separator ? root.renderer.getElementBounds(separator.id) : null;
    expect(bounds).not.toBeNull();
    if (bounds) {
      const x = bounds[0]! + bounds[2]! / 2;
      const y = bounds[1]! + 30;
      root.renderer.nativeSimulateMouseDown(x, y, 0);
      root.renderer.nativeSimulateMouseMove(x + 70, y, 0);
      root.renderer.nativeSimulateMouseUp(x + 70, y, 0);
    }

    expect(changes.at(-1)?.sizes.navigation).toBe(310);
    root.unmount();
  });

  nativeTest('reorders docks by dragging a dock handle across its sibling', () => {
    const changes: DockLayoutState[] = [];
    const root = createTestRoot({ width: 800, height: 400 });
    root.render(
      <GpuixUiProvider>
        <DockLayout.Root onValueChange={(value) => changes.push(value)}>
          <DockLayout.Panel id="navigation" defaultSize={240}>
            <DockLayout.Handle testId="navigation-handle">
              <text>Navigation</text>
            </DockLayout.Handle>
          </DockLayout.Panel>
          <DockLayout.Panel id="conversation">
            <DockLayout.Handle testId="conversation-handle">
              <text>Conversation</text>
            </DockLayout.Handle>
          </DockLayout.Panel>
        </DockLayout.Root>
      </GpuixUiProvider>,
    );

    const handle = root.renderer.findByTestId('navigation-handle');
    const handleBounds = handle ? root.renderer.getElementBounds(handle.id) : null;
    const target = root.renderer.findByTestId('conversation-handle');
    const targetBounds = target ? root.renderer.getElementBounds(target.id) : null;
    expect(handleBounds).not.toBeNull();
    expect(targetBounds).not.toBeNull();
    if (handleBounds && targetBounds) {
      const startX = handleBounds[0]! + 6;
      const y = handleBounds[1]! + handleBounds[3]! / 2;
      const endX = targetBounds[0]! + targetBounds[2]! - 6;
      root.renderer.nativeSimulateMouseDown(startX, y, 0);
      root.renderer.nativeSimulateMouseMove(endX, y, 0);
      root.renderer.nativeSimulateMouseUp(endX, y, 0);
    }

    expect(changes.at(-1)?.order).toEqual(['conversation', 'navigation']);
    root.unmount();
  });

  nativeTest('releases the capture when GPUIX sends mouse up to the original handle', () => {
    let presses = 0;
    const root = createTestRoot({ width: 800, height: 400 });
    root.render(
      <GpuixUiProvider>
        <DockLayout.Root>
          <DockLayout.Panel id="navigation" defaultSize={240}>
            <DockLayout.Handle testId="navigation-handle">
              <text>Navigation</text>
            </DockLayout.Handle>
            <Button testId="after-drag-action" onPress={() => presses++}>
              <text>Action</text>
            </Button>
          </DockLayout.Panel>
          <DockLayout.Panel id="conversation" />
        </DockLayout.Root>
      </GpuixUiProvider>,
    );

    const handle = root.renderer.findByTestId('navigation-handle');
    const handleBounds = handle ? root.renderer.getElementBounds(handle.id) : null;
    expect(handleBounds).not.toBeNull();
    if (handleBounds) {
      const x = handleBounds[0]! + 6;
      const y = handleBounds[1]! + handleBounds[3]! / 2;
      root.renderer.nativeSimulateMouseDown(x, y, 0);
      root.renderer.nativeSimulateMouseUp(x, y, 0);
    }

    expect(root.renderer.findByTestId('dock-drag-capture')).toBeUndefined();
    const action = root.renderer.findByTestId('after-drag-action');
    const actionBounds = action ? root.renderer.getElementBounds(action.id) : null;
    if (actionBounds) {
      root.renderer.nativeSimulateClick(actionBounds[0]! + 4, actionBounds[1]! + 4);
    }
    expect(presses).toBe(1);
    root.unmount();
  });
});
