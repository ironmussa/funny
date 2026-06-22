import { render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { CenterDockview } from '@/components/CenterDockview';
import type { RightTabSpec } from '@/components/DockviewLayout';

const dockviewMock = vi.hoisted(() => ({
  api: undefined as MockDockviewApi | undefined,
  readyCalled: false,
}));

vi.mock('next-themes', () => ({
  useTheme: () => ({ resolvedTheme: 'light' }),
}));

vi.mock('dockview-react', async () => {
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
  addPanel: ReturnType<typeof vi.fn>;
  getPanel: ReturnType<typeof vi.fn>;
  onDidActivePanelChange: ReturnType<typeof vi.fn>;
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

  const api = {
    panels: [] as MockDockviewPanel[],
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
    onDidActivePanelChange: vi.fn(),
    onDidLayoutChange: vi.fn(),
    toJSON: vi.fn(() => ({ grid: {}, panels: {} })),
    fromJSON: vi.fn(),
  };

  return api;
}

function reviewTabs(): RightTabSpec[] {
  return [
    { id: 'changes', title: 'Changes', content: <div>Commit buttons</div> },
    { id: 'graph', title: 'History', content: <div>Commit history</div> },
  ];
}

describe('CenterDockview right tabs', () => {
  beforeEach(() => {
    localStorage.clear();
    dockviewMock.api = createMockDockviewApi();
    dockviewMock.readyCalled = false;
  });

  test('keeps inactive review tab content hidden while mounted', async () => {
    const tabs = reviewTabs();
    const { rerender } = render(
      <CenterDockview
        thread={<div>Thread</div>}
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
      <CenterDockview
        thread={<div>Thread</div>}
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
});
