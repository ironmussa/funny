import { afterEach, beforeEach, expect, test, vi, mock } from 'bun:test';

import { stubGlobal, unstubAllGlobals } from '@funny/test-kit';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';

import { DockviewLayout } from '@/components/DockviewLayout';

mock.module('next-themes', () => ({
  useTheme: () => ({ resolvedTheme: 'light' }),
}));

beforeEach(() => {
  localStorage.clear();
  stubGlobal('PointerEvent', MouseEvent);
});
afterEach(() => {
  cleanup();
  unstubAllGlobals();
});

// Real Dockview + a debounced layout save: generous waits so the test stays
// deterministic under full-suite parallel load (it takes ~1s in isolation).
const WAIT = { timeout: 5_000 };

test('real Dockview switches review tabs and restores the saved layout', async () => {
  const onActiveRightTabChange = vi.fn();
  function Workspace({ initialTab = 'changes' }: { initialTab?: string }) {
    const [activeTab, setActiveTab] = useState(initialTab);
    return (
      <DockviewLayout
        left={<div>Sidebar</div>}
        center={<div>Thread content</div>}
        rightTabs={[
          { id: 'changes', title: 'Changes', content: <div>Commit buttons</div> },
          { id: 'graph', title: 'History', content: <div>Commit history</div> },
        ]}
        activeRightTab={activeTab}
        onActiveRightTabChange={(id) => {
          setActiveTab(id);
          onActiveRightTabChange(id);
        }}
      />
    );
  }
  const { unmount } = render(<Workspace />);

  expect(await screen.findByText('Thread content', {}, WAIT)).toBeVisible();
  fireEvent.pointerDown(screen.getByText('History'), { button: 0 });
  fireEvent.pointerUp(screen.getByText('History'), { button: 0 });
  await waitFor(() => {
    expect(onActiveRightTabChange).toHaveBeenLastCalledWith('graph');
    expect(screen.getByText('Commit history')).toBeVisible();
    expect(screen.getByText('Commit buttons')).not.toBeVisible();
  }, WAIT);
  await waitFor(() => {
    const saved = JSON.parse(localStorage.getItem('dockview.layout.v9') ?? 'null');
    expect(Object.keys(saved?.panels ?? {}).sort()).toEqual([
      'center',
      'left',
      'right:changes',
      'right:graph',
    ]);
  }, WAIT);

  unmount();
  // The selected review tab is controlled by the parent (navigation state).
  render(<Workspace initialTab="graph" />);

  expect(await screen.findByText('Thread content', {}, WAIT)).toBeVisible();
  // Dockview restores the saved layout, then activates the controlled tab
  // asynchronously — wait for it instead of asserting on the first paint.
  await waitFor(() => {
    expect(screen.getByText('Commit history')).toBeVisible();
    expect(screen.getByText('Commit buttons')).not.toBeVisible();
  }, WAIT);
  fireEvent.pointerDown(screen.getByText('Changes'), { button: 0 });
  fireEvent.pointerUp(screen.getByText('Changes'), { button: 0 });
  await waitFor(() => {
    expect(onActiveRightTabChange).toHaveBeenLastCalledWith('changes');
    expect(screen.getByText('Commit buttons')).toBeVisible();
  }, WAIT);
}, 20_000);
