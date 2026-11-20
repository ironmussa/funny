import type { Meta, StoryObj } from '@storybook/react-vite';

import { BranchBadge } from '@/components/BranchBadge';

const meta = {
  title: 'Components/BranchBadge',
  component: BranchBadge,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof BranchBadge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { branch: 'main' },
};

export const ExtraSmall: Story = {
  args: { branch: 'main', size: 'xs' },
};

export const Small: Story = {
  args: { branch: 'feature/add-auth', size: 'sm' },
};

export const Medium: Story = {
  args: { branch: 'feature/add-auth', size: 'md' },
};

export const LongBranchName: Story = {
  args: { branch: 'feature/JIRA-1234-implement-user-authentication-with-oauth2' },
};

export const AllSizes: Story = {
  args: { branch: 'main' },
  render: () => (
    <div className="flex flex-col gap-3">
      <BranchBadge branch="main" size="xs" />
      <BranchBadge branch="main" size="sm" />
      <BranchBadge branch="main" size="md" />
    </div>
  ),
};

export const Plain: Story = {
  args: { branch: 'feature/add-auth', variant: 'plain' },
};
