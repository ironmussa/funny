import { afterEach, beforeEach, describe, expect, test, vi, type Mock, mock } from 'bun:test';

import { stubGlobal, unstubAllGlobals } from '@funny/test-kit';
import { render, screen, waitFor, within } from '@testing-library/react';

import type { RightTabSpec } from '@/components/dockview/types';
import { DockviewLayout } from '@/components/DockviewLayout';

interface DockviewMockState {
  api: MockDockviewApi | undefined;
  readyCalled: boolean;
}

const dockviewMock = ((): DockviewMockState => ({
  api: undefined,
  readyCalled: false,
}))();

mock.module('next-themes', () => ({
  useTheme: () => ({ resolvedTheme: 'light' }),
}));

mock.module('dockview-react', async () => {
  const React = await import('react');

  return {
    DockviewReact: (props: {
      components: Record<string, React.ComponentType<any>>;
      onReady?: (event: { api: MockDockviewApi }) => void;
    }) => {
      const [, forceRender] = React.useState(0);

      React.useEffect(() => {
        if (dockviewMock.readyCalled || !dockviewMock.api) return;
        dockviewMock.readyCalled = true;
        props.onReady?.({ api: dockviewMock.api });
        forceRender((value) => value + 1);
      }, [props]);

      return (
        <div data-testid="mock-dockview">
          {dockviewMock.api?.panels.map((panel) => {
            const Component = props.components[panel.component];
            return (
              <div key={panel.id} data-testid={`dockview-panel-${panel.id}`}>
                <Component api={panel} params={panel.params} />
              </div>
            );
          })}
        </div>
      );
    },
  };
});

type MockDockviewGroup = {
  width: number;
  header: { hidden: boolean };
  api: {
    setConstraints: ReturnType<typeof vi.fn>;
  };
};

type MockDockviewPanel = {
  id: string;
  title: string;
  component: string;
  params?: { hostId?: string };
  group: MockDockviewGroup;
  api: {
    isActive: boolean;
    close: ReturnType<typeof vi.fn>;
    setSize: ReturnType<typeof vi.fn>;
    setActive: ReturnType<typeof vi.fn>;
  };
};

type MockDockviewApi = {
  panels: MockDockviewPanel[];
  addPanel: Mock<(...args: any[]) => any>;
  getPanel: ReturnType<typeof vi.fn>;
  addEdgeGroup: ReturnType<typeof vi.fn>;
  getEdgeGroup: ReturnType<typeof vi.fn>;
  onDidActivePanelChange: ReturnType<typeof vi.fn>;
  onDidRemovePanel: ReturnType<typeof vi.fn>;
  onDidLayoutChange: ReturnType<typeof vi.fn>;
  toJSON: ReturnType<typeof vi.fn>;
  fromJSON: ReturnType<typeof vi.fn>;
};

function createMockDockviewApi(): MockDockviewApi {
  const rightGroup: MockDockviewGroup = {
    width: 400,
    header: { hidden: false },
    api: {
      setConstraints: vi.fn(),
    },
  };

  const edgeGroups = new Map<string, { isCollapsed: () => boolean }>();
  const api = {
    panels: new Array<MockDockviewPanel>(),
    addPanel: vi.fn(
      (options: {
        id: string;
        title?: string;
        component: string;
        params?: { hostId?: string };
        initialWidth?: number;
        position?: { direction?: string; referencePanel?: string };
      }) => {
        const group =
          options.position?.direction === 'within' && options.position.referencePanel
            ? (api.panels.find((panel) => panel.id === options.position?.referencePanel)?.group ??
              rightGroup)
            : rightGroup;
        if (typeof options.initialWidth === 'number') group.width = options.initialWidth;

        const panel: MockDockviewPanel = {
          id: options.id,
          title: options.title ?? options.id,
          component: options.component,
          params: options.params,
          group,
          api: {
            isActive: false,
            close: vi.fn(() => {
              api.panels = api.panels.filter((candidate) => candidate !== panel);
            }),
            setSize: vi.fn(({ width }: { width?: number }) => {
              if (typeof width === 'number') group.width = width;
            }),
            setActive: vi.fn(() => {
              for (const candidate of api.panels) candidate.api.isActive = false;
              panel.api.isActive = true;
            }),
          },
        };

        api.panels.push(panel);
        return panel;
      },
    ),
    getPanel: vi.fn((id: string) => api.panels.find((panel) => panel.id === id)),
    addEdgeGroup: vi.fn((_side: string, options: { id: string }) => {
      edgeGroups.set(options.id, { isCollapsed: () => false });
    }),
    getEdgeGroup: vi.fn((side: string) => edgeGroups.get(`${side}-edge`) ?? null),
    onDidActivePanelChange: vi.fn(),
    onDidRemovePanel: vi.fn(),
    onDidLayoutChange: vi.fn(),
    toJSON: vi.fn(() => ({ grid: {}, panels: {} })),
    fromJSON: vi.fn(),
  };

  return api;
}

function addPanelTo(
  api: MockDockviewApi,
  options: {
    id: string;
    component: string;
    params?: { hostId?: string };
    position?: { direction?: string; referencePanel?: string };
  },
) {
  api.addPanel(options);
}

/** What every saved layout holds: the sidebar edge group, the sidebar and the center. */
function restoreShell(api: MockDockviewApi) {
  api.addEdgeGroup('left', { id: 'left-edge' });
  addPanelTo(api, { id: 'left', component: 'left' });
  addPanelTo(api, { id: 'center', component: 'center' });
}

const SAVED_LAYOUT_KEY = 'dockview.layout.v9';

function reviewTabs(): RightTabSpec[] {
  return [
    { id: 'changes', title: 'Changes', content: <div>Commit buttons</div> },
    { id: 'graph', title: 'History', content: <div>Commit history</div> },
  ];
}

describe('DockviewLayout right pane', () => {
  afterEach(() => unstubAllGlobals());
  beforeEach(() => {
    localStorage.clear();
    dockviewMock.api = createMockDockviewApi();
    dockviewMock.readyCalled = false;
  });

  test('keeps inactive review tab content hidden while mounted', async () => {
    const tabs = reviewTabs();
    const { rerender } = render(
      <DockviewLayout
        left={<div>Sidebar</div>}
        center={<div>Thread</div>}
        rightTabs={tabs}
        activeRightTab="changes"
        rightPaneOpen
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('Commit buttons')).toBeInTheDocument();
      expect(screen.getByText('Commit history')).toBeInTheDocument();
    });

    rerender(
      <DockviewLayout
        left={<div>Sidebar</div>}
        center={<div>Thread</div>}
        rightTabs={tabs}
        activeRightTab="graph"
        rightPaneOpen
      />,
    );

    const changesPanel = screen.getByTestId('dockview-panel-right:changes');
    const graphPanel = screen.getByTestId('dockview-panel-right:graph');
    const changesContent = within(changesPanel).getByTestId('review-tab-content-changes');
    const graphContent = within(graphPanel).getByTestId('review-tab-content-graph');

    expect(changesContent).toHaveAttribute('hidden');
    expect(graphContent).not.toHaveAttribute('hidden');
  });

  // Regression: the open flag (`tool_panels.open.right`) persists synchronously while
  // the layout snapshot is debounced/suppressed, so after a reload the stored
  // layout can still contain right panels the flag says are closed. Restoring
  // them verbatim rendered a "zombie" review pane — visible, but with every
  // reviewPaneOpen-gated refresh off, leaving the Changes tab stuck on a stale
  // "No changes" for dirty worktrees.
  test('removes restored right panels when the pane flag says closed', async () => {
    localStorage.setItem(SAVED_LAYOUT_KEY, JSON.stringify({ grid: {}, panels: {} }));
    const api = dockviewMock.api!;
    api.fromJSON = vi.fn(() => {
      restoreShell(api);
      addPanelTo(api, {
        id: 'right:changes',
        component: 'right-tab',
        params: { hostId: 'right:changes' },
        position: { direction: 'right' },
      });
      addPanelTo(api, {
        id: 'right:graph',
        component: 'right-tab',
        params: { hostId: 'right:graph' },
        position: { direction: 'within', referencePanel: 'right:changes' },
      });
    });

    render(
      <DockviewLayout
        left={<div>Sidebar</div>}
        center={<div>Thread</div>}
        rightTabs={reviewTabs()}
        activeRightTab="changes"
        rightPaneOpen={false}
      />,
    );

    await waitFor(() => {
      expect(api.panels.map((panel) => panel.id)).toEqual(['left', 'center']);
    });
  });

  test('re-adds right panels when the flag says open but the restored layout lost them', async () => {
    localStorage.setItem(SAVED_LAYOUT_KEY, JSON.stringify({ grid: {}, panels: {} }));
    const api = dockviewMock.api!;
    api.fromJSON = vi.fn(() => {
      restoreShell(api);
    });

    render(
      <DockviewLayout
        left={<div>Sidebar</div>}
        center={<div>Thread</div>}
        rightTabs={reviewTabs()}
        activeRightTab="changes"
        rightPaneOpen
      />,
    );

    await waitFor(() => {
      expect(api.panels.map((panel) => panel.id)).toEqual([
        'left',
        'center',
        'right:changes',
        'right:graph',
      ]);
    });
  });

  // Regression: the close path removes panels while the layout persister is
  // suppressed (isAnimatingRef), so the stored layout kept the right panels
  // forever — the entry point for the zombie-pane divergence above.
  test('persists the layout after the pane closes', async () => {
    // The close animation runs on requestAnimationFrame; finish it at once so
    // the test does not depend on frame timing under parallel load.
    stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) =>
      setTimeout(() => cb(performance.now() + 10_000), 0),
    );
    const api = dockviewMock.api!;
    const { rerender } = render(
      <DockviewLayout
        left={<div>Sidebar</div>}
        center={<div>Thread</div>}
        rightTabs={reviewTabs()}
        activeRightTab="changes"
        rightPaneOpen
      />,
    );

    await waitFor(() => {
      expect(api.panels.some((panel) => panel.id === 'right:changes')).toBe(true);
    });
    expect(localStorage.getItem(SAVED_LAYOUT_KEY)).toBeNull();

    rerender(
      <DockviewLayout
        left={<div>Sidebar</div>}
        center={<div>Thread</div>}
        rightTabs={reviewTabs()}
        activeRightTab="changes"
        rightPaneOpen={false}
      />,
    );

    await waitFor(
      () => {
        expect(api.panels.some((panel) => panel.id === 'right:changes')).toBe(false);
        expect(localStorage.getItem(SAVED_LAYOUT_KEY)).not.toBeNull();
      },
      // The 500 ms debounced save, with room for parallel load.
      { timeout: 3000 },
    );
  });
});

describe('DockviewLayout drops the layouts saved before tool panels', () => {
  beforeEach(() => {
    localStorage.clear();
    dockviewMock.api = createMockDockviewApi();
    dockviewMock.readyCalled = false;
  });

  test('ignores the old layouts and keeps the right pane width', async () => {
    localStorage.setItem('dockview.layout.v8', JSON.stringify({ grid: {}, panels: {} }));
    localStorage.setItem('center-dockview.layout.v1', JSON.stringify({ grid: {}, panels: {} }));
    localStorage.setItem('center-dockview.right_width', '612');
    const api = dockviewMock.api!;

    render(<DockviewLayout left={<div>Sidebar</div>} center={<div>Thread</div>} />);

    await waitFor(() => expect(api.panels.map((p) => p.id)).toEqual(['center', 'left']));
    expect(api.fromJSON).not.toHaveBeenCalled();
    expect(localStorage.getItem('dockview.layout.v8')).toBeNull();
    expect(localStorage.getItem('center-dockview.layout.v1')).toBeNull();
    expect(localStorage.getItem('center-dockview.right_width')).toBeNull();
    expect(localStorage.getItem('dockview.right_width')).toBe('612');
  });
});
