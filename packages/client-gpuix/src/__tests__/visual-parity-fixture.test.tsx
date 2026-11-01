import { describe, expect, test } from 'bun:test';

import { desktopParityFixture } from '@funny/ui-contracts/fixtures';
import { createTestRoot, hasNativeTestRenderer } from '@gpuix/react/testing';

import { GpuixVisualParityFixtureHost } from '../visual-parity-fixture';

describe('GPUIX visual parity fixture', () => {
  const nativeTest = hasNativeTestRenderer ? test : test.skip;
  nativeTest('renders the shared structural inventory', () => {
    const root = createTestRoot({ width: 1440, height: 900 });
    root.render(<GpuixVisualParityFixtureHost fixture={desktopParityFixture} />);
    expect(root.renderer.findByTestId('parity-navigation')).toBeDefined();
    expect(root.renderer.findByTestId('parity-header')).toBeDefined();
    expect(root.renderer.findByTestId('parity-composer')?.style.maxWidth).toBe(768);
    for (const item of desktopParityFixture.conversation)
      expect(root.renderer.findByTestId(`parity-conversation-${item.id}`)).toBeDefined();
    root.unmount();
  });
});
