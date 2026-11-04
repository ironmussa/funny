import type { Meta, StoryObj } from '@storybook/react-vite';
import { MemoryRouter } from 'react-router-dom';

import '@/i18n/config';
import { SidebarProvider } from '@/components/ui/sidebar';
import { withProjects } from '@/data/projects/testing';
import { useAuthStore } from '@/stores/auth-store';
import { useProjectStore } from '@/stores/project-store';
import { useUIStore } from '@/stores/ui-store';

import { SettingsPanel } from './SettingsPanel';

function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <MemoryRouter>
      <SidebarProvider>
        <div className="flex h-screen w-[240px] overflow-hidden">{children}</div>
      </SidebarProvider>
    </MemoryRouter>
  );
}

function seedStores({
  selectedProjectId = 'proj-1',
  activeSettingsPage = 'general',
  role = 'admin' as 'admin' | 'user',
} = {}) {
  useProjectStore.setState(
    withProjects({
      projects: [
        {
          id: 'proj-1',
          name: 'funny',
          path: '/home/user/projects/funny',
          userId: 'user-1',
          sortOrder: 0,
          createdAt: new Date().toISOString(),
        },
      ],
      selectedProjectId,
      initialized: true,
    }),
  );
  useAuthStore.setState({
    user: { id: 'user-1', username: 'admin', displayName: 'Admin User', role },
    isAuthenticated: true,
    isLoading: false,
    activeOrgId: null,
    activeOrgName: null,
    activeOrgSlug: null,
  });
  useUIStore.setState({
    settingsOpen: true,
    activeSettingsPage,
  });
}

const meta = {
  title: 'Settings/SettingsPanel',
  component: SettingsPanel,
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
} satisfies Meta<typeof SettingsPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Project settings panel with all menu items (admin user). */
export const ProjectSettings: Story = {
  render: () => {
    seedStores({ selectedProjectId: 'proj-1', activeSettingsPage: 'general', role: 'admin' });
    return (
      <Wrapper>
        <SettingsPanel />
      </Wrapper>
    );
  },
};

/** Global settings panel (no project selected). Shows archived-threads + admin items. */
export const GlobalSettings: Story = {
  render: () => {
    seedStores({ selectedProjectId: null as any, activeSettingsPage: 'general', role: 'admin' });
    useProjectStore.setState({ selectedProjectId: null });
    return (
      <Wrapper>
        <SettingsPanel />
      </Wrapper>
    );
  },
};

/** Settings panel for a non-admin user (no Users/Team Members items). */
export const NonAdminUser: Story = {
  render: () => {
    seedStores({ selectedProjectId: 'proj-1', activeSettingsPage: 'hooks', role: 'user' });
    return (
      <Wrapper>
        <SettingsPanel />
      </Wrapper>
    );
  },
};

/** MCP Server page selected. */
export const McpServerActive: Story = {
  render: () => {
    seedStores({ selectedProjectId: 'proj-1', activeSettingsPage: 'mcp-server' });
    return (
      <Wrapper>
        <SettingsPanel />
      </Wrapper>
    );
  },
};
