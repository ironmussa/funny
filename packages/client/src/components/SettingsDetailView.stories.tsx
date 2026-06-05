import type { Meta, StoryObj } from '@storybook/react-vite';
import { MemoryRouter } from 'react-router-dom';

import '@/i18n/config';
import { useAuthStore } from '@/stores/auth-store';
import { useProjectStore } from '@/stores/project-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useUIStore } from '@/stores/ui-store';

import { SettingsDetailView } from './SettingsDetailView';

function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <MemoryRouter>
      <div className="border-border flex h-[700px] w-[800px] overflow-hidden rounded-lg border">
        {children}
      </div>
    </MemoryRouter>
  );
}

function seedStores({
  activeSettingsPage = 'general',
  selectedProjectId = 'proj-1' as string | null,
} = {}) {
  useProjectStore.setState({
    projects: [
      {
        id: 'proj-1',
        name: 'funny',
        path: '/home/user/projects/funny',
        color: '#3b82f6',
        userId: 'user-1',
        sortOrder: 0,
        createdAt: new Date().toISOString(),
        defaultMode: 'worktree',
        defaultModel: 'sonnet',
        defaultProvider: 'claude',
        defaultPermissionMode: 'autoEdit',
        followUpMode: 'interrupt',
        systemPrompt: 'Always use TypeScript strict mode.',
        urls: ['https://github.com/example/funny'],
      },
    ],
    selectedProjectId,
    initialized: true,
  });
  useAuthStore.setState({
    user: { id: 'user-1', username: 'admin', displayName: 'Admin', role: 'admin' },
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
  useSettingsStore.setState({
    toolPermissions: {
      Read: 'allow',
      Edit: 'allow',
      Write: 'allow',
      Bash: 'ask',
      Glob: 'allow',
      Grep: 'allow',
      WebSearch: 'deny',
      WebFetch: 'allow',
      Task: 'allow',
      TodoWrite: 'allow',
      NotebookEdit: 'allow',
    },
  });
}

const meta = {
  title: 'Settings/SettingsDetailView',
  component: SettingsDetailView,
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
} satisfies Meta<typeof SettingsDetailView>;

export default meta;
type Story = StoryObj<typeof meta>;

/** General settings with a project selected — shows project config + tool permissions. */
export const GeneralWithProject: Story = {
  render: () => {
    seedStores({ activeSettingsPage: 'general', selectedProjectId: 'proj-1' });
    return (
      <Wrapper>
        <SettingsDetailView />
      </Wrapper>
    );
  },
};

/** General settings without a project — shows only tool permissions. */
export const GeneralNoProject: Story = {
  render: () => {
    seedStores({ activeSettingsPage: 'general', selectedProjectId: null });
    return (
      <Wrapper>
        <SettingsDetailView />
      </Wrapper>
    );
  },
};

/** No settings page selected — shows the "Select a setting" placeholder. */
export const NoPageSelected: Story = {
  render: () => {
    seedStores({ activeSettingsPage: null as any });
    useUIStore.setState({ activeSettingsPage: null });
    return (
      <Wrapper>
        <SettingsDetailView />
      </Wrapper>
    );
  },
};
