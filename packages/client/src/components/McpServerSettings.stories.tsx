import type { Meta, StoryObj } from '@storybook/react-vite';
import { MemoryRouter } from 'react-router-dom';

import '@/i18n/config';
import { withProjects } from '@/data/projects/testing';
import { useProjectStore } from '@/stores/project-store';

import { McpServerSettings } from './McpServerSettings';

function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <MemoryRouter>
      <div className="max-w-4xl p-6">{children}</div>
    </MemoryRouter>
  );
}

function seedStores({ selectedProjectId = 'proj-1' as string | null } = {}) {
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
}

const meta = {
  title: 'Settings/McpServerSettings',
  component: McpServerSettings,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof McpServerSettings>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Default view with a project selected — servers loaded from API. */
export const Default: Story = {
  render: () => {
    seedStores({ selectedProjectId: 'proj-1' });
    return (
      <Wrapper>
        <McpServerSettings />
      </Wrapper>
    );
  },
};

/** No project selected — shows "select a project" message. */
export const NoProject: Story = {
  render: () => {
    seedStores({ selectedProjectId: null });
    useProjectStore.setState(withProjects({ projects: [], selectedProjectId: null }));
    return (
      <Wrapper>
        <McpServerSettings />
      </Wrapper>
    );
  },
};
