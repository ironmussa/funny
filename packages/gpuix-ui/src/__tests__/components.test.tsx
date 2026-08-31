import { describe, expect, test } from 'bun:test';

import { createTestRoot, hasNativeTestRenderer } from '@gpuix/react/testing';

import { Button } from '../button';
import { eventValue, Input, Textarea } from '../input';
import { NavItem } from '../nav-item';
import { GpuixUiProvider } from '../theme';

describe('gpuix-ui components', () => {
  const nativeTest = hasNativeTestRenderer ? test : test.skip;

  nativeTest('renders themed controls and dispatches button clicks', () => {
    let presses = 0;
    const root = createTestRoot({ width: 500, height: 300 });
    root.render(
      <GpuixUiProvider>
        <div style={{ width: 400, height: 240, gap: 8, padding: 12 }}>
          <Button testId="save" onPress={() => presses++}>
            <text>Save</text>
          </Button>
          <Input testId="name" value="Ada" />
          <NavItem testId="thread" selected onSelect={() => presses++}>
            <text>Thread</text>
          </NavItem>
        </div>
      </GpuixUiProvider>,
    );

    const button = root.renderer.findByTestId('save');
    expect(button?.style.backgroundColor).toBe('#315da8');
    expect(root.renderer.findByTestId('name')?.style.borderRadius).toBe(7);
    expect(root.renderer.findByTestId('name')?.customProps?.theme).toEqual({
      caret: '#315da8',
    });
    expect(root.renderer.findByTestId('thread')?.style.backgroundColor).toBe('#315da8');

    const bounds = button ? root.renderer.getElementBounds(button.id) : null;
    expect(bounds).not.toBeNull();
    if (bounds) root.renderer.nativeSimulateClick(bounds[0]! + 2, bounds[1]! + 2);
    expect(presses).toBe(1);
    root.unmount();
  });

  nativeTest('uses native textarea editing and submit semantics', () => {
    const changes: string[] = [];
    const submissions: string[] = [];
    const root = createTestRoot();
    root.render(
      <GpuixUiProvider>
        <Textarea
          testId="composer"
          value=""
          onValueChange={(value) => changes.push(value)}
          onSubmit={(event) => submissions.push(eventValue(event))}
        />
      </GpuixUiProvider>,
    );

    const composer = root.renderer.findByTestId('composer');
    expect(composer).not.toBeNull();
    if (composer) {
      root.renderer.nativeSimulateKeystrokes(composer.id, 'h i shift-enter t h e r e enter');
    }

    expect(changes).toContain('hi\nthere');
    expect(submissions).toEqual(['hi\nthere']);
    root.unmount();
  });

  nativeTest('does not dispatch disabled buttons', () => {
    let presses = 0;
    const root = createTestRoot();
    root.render(
      <Button testId="disabled" disabled onPress={() => presses++}>
        <text>Disabled</text>
      </Button>,
    );
    const button = root.renderer.findByTestId('disabled');
    const bounds = button ? root.renderer.getElementBounds(button.id) : null;
    if (bounds) root.renderer.nativeSimulateClick(bounds[0]! + 2, bounds[1]! + 2);
    expect(presses).toBe(0);
    root.unmount();
  });
});
