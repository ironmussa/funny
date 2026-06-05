import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import { DockviewLayout, type BottomTabSpec, type RightTabSpec } from '@/components/DockviewLayout';
import { Button } from '@/components/ui/button';

function PanelPlaceholder({
  label,
  tone = 'center',
}: {
  label: string;
  tone?: 'left' | 'center' | 'right' | 'bottom' | 'browser';
}) {
  const toneClass =
    tone === 'left'
      ? 'bg-sidebar text-sidebar-foreground'
      : tone === 'right'
        ? 'bg-sidebar text-sidebar-foreground'
        : tone === 'bottom'
          ? 'bg-card text-foreground'
          : tone === 'browser'
            ? 'bg-muted text-foreground'
            : 'bg-background text-foreground';

  return (
    <div
      className={`flex h-full w-full items-center justify-center ${toneClass}`}
      data-testid={`dockview-placeholder-${tone}`}
    >
      <span className="text-muted-foreground text-sm">{label}</span>
    </div>
  );
}

const REVIEW_TABS: RightTabSpec[] = [
  { id: 'changes', title: 'Changes', content: <PanelPlaceholder label="Changes" tone="right" /> },
  { id: 'history', title: 'History', content: <PanelPlaceholder label="History" tone="right" /> },
  { id: 'stash', title: 'Stash', content: <PanelPlaceholder label="Stash" tone="right" /> },
  { id: 'prs', title: 'PRs', content: <PanelPlaceholder label="PRs" tone="right" /> },
];

function DockviewLayoutDemo({
  initialLeftOpen = true,
  initialRightOpen = true,
  initialBottomOpen = true,
  initialBrowserOpen = false,
  useReviewTabs = true,
}: {
  initialLeftOpen?: boolean;
  initialRightOpen?: boolean;
  initialBottomOpen?: boolean;
  initialBrowserOpen?: boolean;
  useReviewTabs?: boolean;
}) {
  const [leftOpen, setLeftOpen] = useState(initialLeftOpen);
  const [rightOpen, setRightOpen] = useState(initialRightOpen);
  const [bottomOpen, setBottomOpen] = useState(initialBottomOpen);
  const [browserOpen, setBrowserOpen] = useState(initialBrowserOpen);
  const [activeRightTab, setActiveRightTab] = useState('changes');
  const [activeBottomTab, setActiveBottomTab] = useState('term-1');

  const bottomTabs: BottomTabSpec[] = [
    {
      id: 'term-1',
      title: 'Bash 1',
      content: <PanelPlaceholder label="Terminal 1" tone="bottom" />,
    },
    {
      id: 'term-2',
      title: 'Bash 2',
      content: <PanelPlaceholder label="Terminal 2" tone="bottom" />,
    },
  ];

  return (
    <div className="flex h-[720px] w-full flex-col">
      <div className="border-border bg-card flex shrink-0 items-center gap-2 border-b px-3 py-2">
        <Button
          size="sm"
          variant={leftOpen ? 'secondary' : 'outline'}
          data-testid="dockview-story-toggle-left"
          onClick={() => setLeftOpen((v) => !v)}
        >
          Sidebar
        </Button>
        <Button
          size="sm"
          variant={rightOpen ? 'secondary' : 'outline'}
          data-testid="dockview-story-toggle-right"
          onClick={() => setRightOpen((v) => !v)}
        >
          Review
        </Button>
        <Button
          size="sm"
          variant={bottomOpen ? 'secondary' : 'outline'}
          data-testid="dockview-story-toggle-bottom"
          onClick={() => setBottomOpen((v) => !v)}
        >
          Terminal
        </Button>
        <Button
          size="sm"
          variant={browserOpen ? 'secondary' : 'outline'}
          data-testid="dockview-story-toggle-browser"
          onClick={() => setBrowserOpen((v) => !v)}
        >
          Browser
        </Button>
      </div>
      <div className="min-h-0 flex-1">
        <DockviewLayout
          left={<PanelPlaceholder label="Sidebar" tone="left" />}
          center={<PanelPlaceholder label="Thread / Chat" tone="center" />}
          right={
            useReviewTabs ? undefined : <PanelPlaceholder label="Activity / Files" tone="right" />
          }
          rightTabs={useReviewTabs ? REVIEW_TABS : undefined}
          activeRightTab={activeRightTab}
          onActiveRightTabChange={setActiveRightTab}
          rightPaneOpen={rightOpen}
          bottomTabs={bottomTabs}
          activeBottomTab={activeBottomTab}
          onActiveBottomTabChange={setActiveBottomTab}
          onBottomTabClose={(id) => {
            if (activeBottomTab === id) {
              setActiveBottomTab(bottomTabs.find((t) => t.id !== id)?.id ?? '');
            }
          }}
          bottomPaneOpen={bottomOpen}
          browser={<PanelPlaceholder label="Browser annotator" tone="browser" />}
          browserOpen={browserOpen}
          onBrowserClose={() => setBrowserOpen(false)}
          leftPaneOpen={leftOpen}
          initialLeftWidth={240}
          initialRightWidth={360}
          initialBottomHeight={220}
          initialBrowserWidth={420}
        />
      </div>
    </div>
  );
}

const meta = {
  title: 'Layout/DockviewLayout',
  component: DockviewLayoutDemo,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Phase-0 spike for the Dockview workspace shell. Drag splitters, toggle panes with the toolbar, and verify light/dark theming via Storybook controls.',
      },
    },
  },
  tags: ['autodocs'],
  decorators: [
    (Story) => {
      try {
        for (const key of Object.keys(localStorage)) {
          if (key.startsWith('dockview.')) localStorage.removeItem(key);
        }
      } catch {
        // ignore — private mode / blocked storage
      }
      return <Story />;
    },
  ],
} satisfies Meta<typeof DockviewLayoutDemo>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Default IDE layout: sidebar + chat + review tabs + terminal strip. */
export const Default: Story = {};

/** Review pane hidden — center column expands. */
export const ReviewClosed: Story = {
  args: { initialRightOpen: false },
};

/** Collapsed sidebar — left edge group fully hidden. */
export const SidebarCollapsed: Story = {
  args: { initialLeftOpen: false },
};

/** Terminal strip hidden — chat fills the center column. */
export const TerminalHidden: Story = {
  args: { initialBottomOpen: false },
};

/** Single right panel instead of Changes/History/Stash/PRs tabs. */
export const SingleRightPanel: Story = {
  args: { useReviewTabs: false },
};

/** Browser annotator panel open between center and review. */
export const WithBrowserPanel: Story = {
  args: { initialBrowserOpen: true },
};
