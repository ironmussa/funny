import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { CenterDockview } from '@/components/CenterDockview';

vi.mock('next-themes', () => ({
  useTheme: () => ({ resolvedTheme: 'light' }),
}));

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('PointerEvent', MouseEvent);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test('real Dockview switches review tabs and restores the saved layout', async () => {
  const onActiveRightTabChange = vi.fn();
  function Workspace({ initialTab = 'changes' }: { initialTab?: string }) {
    const [activeTab, setActiveTab] = useState(initialTab);
    return (
      <CenterDockview
        thread={<div>Thread content</div>}
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

  expect(await screen.findByText('Thread content')).toBeVisible();
  fireEvent.pointerDown(screen.getByText('History'), { button: 0 });
  fireEvent.pointerUp(screen.getByText('History'), { button: 0 });
  await waitFor(() => {
    expect(onActiveRightTabChange).toHaveBeenLastCalledWith('graph');
    expect(screen.getByText('Commit history')).toBeVisible();
    expect(screen.getByText('Commit buttons')).not.toBeVisible();
  });
  await waitFor(() => {
    const saved = JSON.parse(localStorage.getItem('center-dockview.layout.v1') ?? 'null');
    expect(Object.keys(saved?.panels ?? {}).sort()).toEqual([
      'right:changes',
      'right:graph',
      'thread',
    ]);
  });

  unmount();
  // The selected review tab is controlled by the parent (navigation state).
  render(<Workspace initialTab="graph" />);

  expect(await screen.findByText('Thread content')).toBeVisible();
  expect(screen.getByText('Commit history')).toBeVisible();
  expect(screen.getByText('Commit buttons')).not.toBeVisible();
  fireEvent.pointerDown(screen.getByText('Changes'), { button: 0 });
  fireEvent.pointerUp(screen.getByText('Changes'), { button: 0 });
  await waitFor(() => {
    expect(onActiveRightTabChange).toHaveBeenLastCalledWith('changes');
    expect(screen.getByText('Commit buttons')).toBeVisible();
  });
});
