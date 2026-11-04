import type { Meta, StoryObj } from '@storybook/react-vite';
import { MemoryRouter } from 'react-router-dom';

import '@/i18n/config';
import { withProjects, withSampleProject } from '@/data/projects/testing';
import { useAppStore } from '@/stores/app-store';

import { WorktreeSettings } from './WorktreeSettings';

function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <MemoryRouter>
      <div className="max-w-4xl p-6">{children}</div>
    </MemoryRouter>
  );
}

const meta = {
  title: 'Settings/WorktreeSettings',
  component: WorktreeSettings,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof WorktreeSettings>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Default view with a project selected — worktrees loaded from API. */
export const Default: Story = {
  render: () => {
    useAppStore.setState(withSampleProject());
    return (
      <Wrapper>
        <WorktreeSettings />
      </Wrapper>
    );
  },
};

/** No project selected — shows empty message. */
export const NoProject: Story = {
  render: () => {
    useAppStore.setState(withProjects({ selectedProjectId: null, projects: [] }));
    return (
      <Wrapper>
        <WorktreeSettings />
      </Wrapper>
    );
  },
};
