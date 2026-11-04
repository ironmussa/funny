import type { Meta, StoryObj } from '@storybook/react-vite';
import { MemoryRouter } from 'react-router-dom';

import '@/i18n/config';
import { withSampleProject } from '@/data/projects/testing';
import { useAppStore } from '@/stores/app-store';

import { SkillsSettings } from './SkillsSettings';

function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <MemoryRouter>
      <div className="max-w-4xl p-6">{children}</div>
    </MemoryRouter>
  );
}

const meta = {
  title: 'Settings/SkillsSettings',
  component: SkillsSettings,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof SkillsSettings>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Default view with a project selected — skills loaded from API. */
export const Default: Story = {
  render: () => {
    useAppStore.setState(withSampleProject());
    return (
      <Wrapper>
        <SkillsSettings />
      </Wrapper>
    );
  },
};
