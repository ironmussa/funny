import { describe, expect, test } from 'bun:test';

import { createTestRoot, hasNativeTestRenderer } from '@gpuix/react/testing';

import { Button, IconButton } from '../button';
import { FileTree } from '../file-tree';
import { Input } from '../input';
import { NavItem } from '../nav-item';
import { darkTheme, GpuixUiProvider, scrollbarStyle } from '../theme';

describe('gpuix-ui accessibility', () => {
  const nativeTest = hasNativeTestRenderer ? test : test.skip;

  test('scrollbar thumb matches the web client thickness and uses the theme', () => {
    expect(scrollbarStyle(darkTheme.colors)).toEqual({
      scrollbarColor: darkTheme.colors.borderStrong,
      scrollbarWidth: 6,
    });
  });

  nativeTest('exposes roles and labels to the accessibility tree', () => {
    const root = createTestRoot({ width: 500, height: 400 });
    root.render(
      <GpuixUiProvider>
        <div style={{ width: 460, height: 360, gap: 8, padding: 12 }}>
          <Button testId="save" onPress={() => {}}>
            <text>Save</text>
          </Button>
          <IconButton testId="close" icon={<text>x</text>} label="Close panel" onPress={() => {}} />
          <Input testId="search" placeholder="Filter files" value="" />
          <NavItem testId="thread" selected onSelect={() => {}}>
            <text>Thread</text>
          </NavItem>
          {/* A virtual list only paints rows when its column gives it a definite height. */}
          <div style={{ display: 'flex', flexDirection: 'column', height: 80 }}>
            <FileTree testId="tree" files={['src/app.ts']} />
          </div>
        </div>
      </GpuixUiProvider>,
    );

    // Node keys and role spellings (ARIA token vs AccessKit enum) are renderer details, so match
    // nodes by their accessible name and state and only require that a role was exposed.
    const nodes = Object.values(root.renderer.getA11yTree().nodes ?? {}).map((node) => node.aria);
    const labelled = (label: string) => nodes.find((aria) => aria?.label === label);

    expect(labelled('Close panel')?.role).toBeDefined();
    expect(labelled('Filter files')?.role).toBeDefined();
    expect(labelled('Files')?.role).toBeDefined();
    expect(labelled('src')).toMatchObject({ level: 1, expanded: true });
    expect(nodes.some((aria) => aria?.role && aria.selected === true)).toBe(true);
    expect(nodes.filter((aria) => aria?.role).length).toBeGreaterThanOrEqual(6);
    root.unmount();
  });
});
