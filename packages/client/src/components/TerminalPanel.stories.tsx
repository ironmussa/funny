import type { Meta, StoryObj } from '@storybook/react-vite';

import '@/i18n/config';
import { useProjectStore } from '@/stores/project-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useTerminalStore, type TerminalTab } from '@/stores/terminal-store';
import { useThreadStore } from '@/stores/thread-store';

import { TerminalPanel } from './TerminalPanel';

// ── Mock data ───────────────────────────────────────────────

const PROJECT_ID = 'proj-1';

const baseTabs: TerminalTab[] = [
  {
    id: 'pty-1',
    label: 'Bash 1',
    cwd: '/home/user/projects/funny',
    alive: true,
    projectId: PROJECT_ID,
    type: 'pty',
    shell: 'default',
  },
];

const multiTabs: TerminalTab[] = [
  ...baseTabs,
  {
    id: 'pty-2',
    label: 'Bash 2',
    cwd: '/home/user/projects/funny',
    alive: true,
    projectId: PROJECT_ID,
    type: 'pty',
    shell: 'default',
  },
  {
    id: 'pty-3',
    label: 'Zsh 1',
    cwd: '/home/user/projects/funny/.worktrees/feat-review-pane',
    alive: true,
    projectId: PROJECT_ID,
    type: 'pty',
    shell: 'zsh',
  },
];

const commandTab: TerminalTab = {
  id: 'cmd-1',
  label: 'dev server',
  cwd: '/home/user/projects/funny',
  alive: true,
  projectId: PROJECT_ID,
  type: 'command',
  commandId: 'cmd-dev-server',
};

const exitedTab: TerminalTab = {
  id: 'pty-exited',
  label: 'Bash 1',
  cwd: '/home/user/projects/funny',
  alive: false,
  projectId: PROJECT_ID,
  type: 'pty',
  shell: 'default',
};

const errorTab: TerminalTab = {
  id: 'pty-error',
  label: 'Bash 1',
  cwd: '/nonexistent/path',
  alive: false,
  projectId: PROJECT_ID,
  type: 'pty',
  shell: 'default',
  error: 'Failed to spawn PTY: no such directory /nonexistent/path',
};

const bellTab: TerminalTab = {
  id: 'pty-bell',
  label: 'Bash 2',
  cwd: '/home/user/projects/funny',
  alive: true,
  projectId: PROJECT_ID,
  type: 'pty',
  shell: 'default',
  hasBell: true,
};

// ── Store seeders ───────────────────────────────────────────

function seedStores(
  opts: {
    tabs?: TerminalTab[];
    activeTabId?: string | null;
    panelVisibleByProject?: Record<string, boolean>;
    commandOutput?: Record<string, string>;
    commandMetrics?: Record<
      string,
      { uptime: number; restartCount: number; memoryUsageKB: number }
    >;
  } = {},
) {
  const {
    tabs = baseTabs,
    activeTabId = tabs[0]?.id ?? null,
    panelVisibleByProject = { [PROJECT_ID]: true },
    commandOutput = {},
    commandMetrics = {},
  } = opts;

  useProjectStore.setState({
    projects: [
      {
        id: PROJECT_ID,
        name: 'funny',
        path: '/home/user/projects/funny',
        color: '#3b82f6',
        userId: 'user-1',
        sortOrder: 0,
        createdAt: new Date().toISOString(),
      },
    ],
    expandedProjects: new Set([PROJECT_ID]),
    selectedProjectId: PROJECT_ID,
    initialized: true,
    branchByProject: { [PROJECT_ID]: 'master' },
  });

  useThreadStore.setState({
    threadsById: {},
    threadIdsByProject: {},
    selectedThreadId: null,
    activeThread: null,
    setupProgressByThread: {},
    contextUsageByThread: {},
  });

  useSettingsStore.setState({
    defaultEditor: 'cursor',
    useInternalEditor: false,
    _initialized: true,
    availableShells: [
      { id: 'default', label: 'Default Shell', path: '/bin/sh' },
      { id: 'bash', label: 'Bash', path: '/bin/bash' },
      { id: 'zsh', label: 'Zsh', path: '/bin/zsh' },
    ],
  });

  useTerminalStore.setState({
    tabs,
    activeTabId,
    panelVisibleByProject,
    sessionsChecked: true,
    commandOutput,
    commandMetrics,
    ptyDataCallbacks: {},
  });
}

// ── Wrapper ─────────────────────────────────────────────────

function TerminalPanelWrapper() {
  return (
    <div className="border-border bg-background flex h-[400px] w-[900px] flex-col border">
      <div className="bg-muted/20 flex-1" />
      <TerminalPanel />
    </div>
  );
}

// ── Meta ────────────────────────────────────────────────────

const meta = {
  title: 'Components/TerminalPanel',
  component: TerminalPanel,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof TerminalPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

// ── Stories ─────────────────────────────────────────────────

/** Single PTY tab with a loading terminal. */
export const Default: Story = {
  render: () => {
    seedStores();
    return <TerminalPanelWrapper />;
  },
};

/** Multiple tabs with different shells. */
export const MultipleTabs: Story = {
  name: 'Multiple Tabs',
  render: () => {
    seedStores({ tabs: multiTabs, activeTabId: 'pty-1' });
    return <TerminalPanelWrapper />;
  },
};

/** No open terminal tabs — shows empty state. */
export const Empty: Story = {
  name: 'No Tabs',
  render: () => {
    seedStores({ tabs: [] });
    return <TerminalPanelWrapper />;
  },
};

/** Tab with an exited process showing the restart button. */
export const ExitedProcess: Story = {
  name: 'Exited Process',
  render: () => {
    seedStores({ tabs: [exitedTab], activeTabId: 'pty-exited' });
    return <TerminalPanelWrapper />;
  },
};

/** Tab showing a PTY spawn error. */
export const SpawnError: Story = {
  name: 'Spawn Error',
  render: () => {
    seedStores({ tabs: [errorTab], activeTabId: 'pty-error' });
    return <TerminalPanelWrapper />;
  },
};

/** Inactive tab has a bell notification badge. */
export const BellNotification: Story = {
  name: 'Bell Notification',
  render: () => {
    const tabs = [baseTabs[0], bellTab];
    seedStores({ tabs, activeTabId: 'pty-1' });
    return <TerminalPanelWrapper />;
  },
};

/** Server-managed command tab with ANSI output and metrics. */
export const CommandTab: Story = {
  name: 'Command Tab',
  render: () => {
    const output = [
      '\x1b[36m[vite]\x1b[0m Dev server running at:',
      '',
      '  \x1b[32m➜\x1b[0m  Local:   \x1b[36mhttp://localhost:5173/\x1b[0m',
      '  \x1b[32m➜\x1b[0m  Network: \x1b[36mhttp://192.168.1.42:5173/\x1b[0m',
      '',
      '\x1b[36m[vite]\x1b[0m ready in \x1b[33m320ms\x1b[0m.',
      '',
      '\x1b[90m12:04:31\x1b[0m \x1b[32m[info]\x1b[0m page reload src/components/TerminalPanel.tsx',
      '\x1b[90m12:04:32\x1b[0m \x1b[32m[info]\x1b[0m hmr update /src/components/TerminalPanel.tsx',
      '\x1b[90m12:05:10\x1b[0m \x1b[33m[warn]\x1b[0m \x1b[33mExperimental feature enabled: css-modules\x1b[0m',
      '\x1b[90m12:06:01\x1b[0m \x1b[31m[error]\x1b[0m \x1b[31mFailed to resolve import "@/missing-module"\x1b[0m',
    ].join('\n');

    seedStores({
      tabs: [commandTab],
      activeTabId: 'cmd-1',
      commandOutput: { 'cmd-dev-server': output },
      commandMetrics: {
        'cmd-dev-server': {
          uptime: 3_723_000,
          restartCount: 0,
          memoryUsageKB: 87_040,
        },
      },
    });
    return <TerminalPanelWrapper />;
  },
};

/** Mix of PTY tabs, command tabs, and an exited tab. */
export const MixedTabs: Story = {
  name: 'Mixed Tabs',
  render: () => {
    const output = '\x1b[32m$\x1b[0m bun run dev\n\x1b[36mStarted dev server on :3001\x1b[0m\n';
    const tabs = [
      baseTabs[0],
      { ...commandTab, id: 'cmd-2', label: 'dev server' },
      { ...exitedTab, id: 'pty-done', label: 'Build' },
    ];
    seedStores({
      tabs,
      activeTabId: 'pty-1',
      commandOutput: { 'cmd-dev-server': output },
    });
    return <TerminalPanelWrapper />;
  },
};

/** Command tab with restarts highlighted in metrics. */
export const CommandWithRestarts: Story = {
  name: 'Command With Restarts',
  render: () => {
    const output =
      '\x1b[33m[warn]\x1b[0m Process restarted due to crash\n\x1b[32m$\x1b[0m Listening on :3001\n';
    seedStores({
      tabs: [commandTab],
      activeTabId: 'cmd-1',
      commandOutput: { 'cmd-dev-server': output },
      commandMetrics: {
        'cmd-dev-server': {
          uptime: 45_000,
          restartCount: 3,
          memoryUsageKB: 32_768,
        },
      },
    });
    return <TerminalPanelWrapper />;
  },
};
