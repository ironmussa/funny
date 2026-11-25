import { beforeEach, describe, expect, test, vi, mock } from 'bun:test';

import { render } from '@testing-library/react';
import type { DockviewReadyEvent } from 'dockview-react';

import type { BottomTabSpec } from '@/components/dockview/types';
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

mock.module('dockview-react', () => ({
  DockviewReact: (props: { onReady?: (event: DockviewReadyEvent) => void }) => {
    if (!dockviewMock.readyCalled) {
      dockviewMock.readyCalled = true;
      // SAFETY: DockviewLayout reads only `event.api`, which the mock api covers.
      // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- test stub with partial shape
      props.onReady?.({ api: dockviewMock.api } as unknown as DockviewReadyEvent);
    }
    return <div data-testid="mock-dockview" />;
  },
}));

type MockDockviewGroup = {
  id: string;
  panels: MockDockviewPanel[];
  width: number;
  height: number;
  header: { hidden: boolean };
  element: HTMLElement;
  isCollapsed: ReturnType<typeof vi.fn>;
  expand: ReturnType<typeof vi.fn>;
  collapse: ReturnType<typeof vi.fn>;
  api: {
    location: { type: 'grid' };
    setConstraints: ReturnType<typeof vi.fn>;
  };
};

type MockDockviewPanel = {
  id: string;
  title: string;
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
  addEdgeGroup: ReturnType<typeof vi.fn>;
  getEdgeGroup: ReturnType<typeof vi.fn>;
  onDidActivePanelChange: ReturnType<typeof vi.fn>;
  onDidRemovePanel: ReturnType<typeof vi.fn>;
  onDidLayoutChange: ReturnType<typeof vi.fn>;
  toJSON: ReturnType<typeof vi.fn>;
  fromJSON: ReturnType<typeof vi.fn>;
};

function createGroup(id: string, height = 300): MockDockviewGroup {
  return {
    id,
    panels: [],
    width: 500,
    height,
    header: { hidden: false },
    element: document.createElement('div'),
    isCollapsed: vi.fn(() => false),
    expand: vi.fn(),
    collapse: vi.fn(),
    api: {
      location: { type: 'grid' },
      setConstraints: vi.fn(),
    },
  };
}

function createMockDockviewApi(): MockDockviewApi {
  const edgeGroups = new Map<string, MockDockviewGroup>();
  const api = {
    panels: new Array<MockDockviewPanel>(),
    addPanel: vi.fn(
      (options: { id: string; title?: string; position?: any; initialHeight?: number }) => {
        let group: MockDockviewGroup | undefined;
        const referencePanelId = options.position?.referencePanel;
        const referenceGroupId = options.position?.referenceGroup;

        if (options.position?.direction === 'within' && referencePanelId) {
          group = api.panels.find((panel) => panel.id === referencePanelId)?.group;
        } else if (referenceGroupId) {
          group = edgeGroups.get(referenceGroupId);
        }

        group ??= createGroup(`group:${options.id}`, options.initialHeight ?? 300);

        const panel: MockDockviewPanel = {
          id: options.id,
          title: options.title ?? options.id,
          group,
          api: {
            isActive: false,
            close: vi.fn(() => {
              api.panels = api.panels.filter((p) => p !== panel);
              group.panels = group.panels.filter((p) => p !== panel);
            }),
            setSize: vi.fn(({ height }: { height?: number }) => {
              if (typeof height === 'number') group.height = height;
            }),
            setActive: vi.fn(() => {
              panel.api.isActive = true;
            }),
          },
        };
        group.panels.push(panel);
        api.panels.push(panel);
        return panel;
      },
    ),
    getPanel: vi.fn((id: string) => api.panels.find((panel) => panel.id === id)),
    addEdgeGroup: vi.fn((_side: string, options: { id: string; initialSize?: number }) => {
      edgeGroups.set(options.id, createGroup(options.id, options.initialSize ?? 300));
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

function terminalTabs(): BottomTabSpec[] {
  return [
    { id: 'one', title: 'One', content: <div>One</div> },
    { id: 'two', title: 'Two', content: <div>Two</div> },
  ];
}

describe('DockviewLayout bottom pane visibility', () => {
  beforeEach(() => {
    localStorage.clear();
    dockviewMock.api = createMockDockviewApi();
    dockviewMock.readyCalled = false;
  });

  test('hides terminal tabs without closing their dockview panels', () => {
    const tabs = terminalTabs();
    const { rerender } = render(
      <DockviewLayout left={<div />} center={<div />} bottomTabs={tabs} bottomPaneOpen />,
    );

    const api = dockviewMock.api!;
    const bottomPanels = api.panels.filter((panel) => panel.id.startsWith('bottom:'));
    expect(bottomPanels).toHaveLength(2);

    rerender(
      <DockviewLayout left={<div />} center={<div />} bottomTabs={tabs} bottomPaneOpen={false} />,
    );

    expect(api.panels.filter((panel) => panel.id.startsWith('bottom:'))).toHaveLength(2);
    expect(bottomPanels[0].api.close).not.toHaveBeenCalled();
    expect(bottomPanels[1].api.close).not.toHaveBeenCalled();
    expect(bottomPanels[0].group.height).toBe(0);

    rerender(<DockviewLayout left={<div />} center={<div />} bottomTabs={tabs} bottomPaneOpen />);

    expect(api.panels.filter((panel) => panel.id.startsWith('bottom:'))).toHaveLength(2);
    expect(bottomPanels[0].group.height).toBe(280);
  });
});

describe('DockviewLayout keeps dragged sizes across thread switches', () => {
  beforeEach(() => {
    localStorage.clear();
    dockviewMock.api = createMockDockviewApi();
    dockviewMock.readyCalled = false;
  });

  /** Simulates the user dragging a splitter: dockview resizes the group and
   *  fires `onDidLayoutChange`, which DockviewLayout persists. */
  function fireLayoutChange(api: MockDockviewApi) {
    for (const call of api.onDidLayoutChange.mock.calls) (call[0] as () => void)();
  }

  function lastAddOptions(api: MockDockviewApi, id: string) {
    const calls = api.addPanel.mock.calls.filter((c) => (c[0] as { id: string }).id === id);
    return calls[calls.length - 1]?.[0] as { initialWidth?: number; initialHeight?: number };
  }

  test('re-opens the browser at the width the user dragged it to', () => {
    const props = { left: <div />, center: <div />, browser: <div />, initialBrowserWidth: 480 };
    const { rerender } = render(<DockviewLayout {...props} browserOpen />);
    const api = dockviewMock.api!;
    expect(lastAddOptions(api, 'browser').initialWidth).toBe(480);

    api.getPanel('browser')!.group.width = 900;
    fireLayoutChange(api);

    // Switching to a thread without the browser closes it; coming back re-adds it.
    rerender(<DockviewLayout {...props} browserOpen={false} />);
    expect(api.getPanel('browser')).toBeUndefined();
    rerender(<DockviewLayout {...props} browserOpen />);

    expect(lastAddOptions(api, 'browser').initialWidth).toBe(900);
  });

  test('re-adds the terminal group at the height the user dragged it to', () => {
    const tabs = terminalTabs();
    const props = { left: <div />, center: <div />, bottomPaneOpen: true };
    const { rerender } = render(<DockviewLayout {...props} bottomTabs={tabs} />);
    const api = dockviewMock.api!;

    api.panels.find((p) => p.id.startsWith('bottom:'))!.group.height = 520;
    fireLayoutChange(api);

    // A thread in a project with no terminals removes the bottom group.
    rerender(<DockviewLayout {...props} bottomTabs={[]} />);
    expect(api.panels.some((p) => p.id.startsWith('bottom:'))).toBe(false);
    rerender(<DockviewLayout {...props} bottomTabs={tabs} />);

    expect(lastAddOptions(api, 'bottom:one').initialHeight).toBe(520);
  });
});
