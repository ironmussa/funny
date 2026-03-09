import type { Meta, StoryObj } from '@storybook/react-vite';

import { StatusBadge } from '@/components/StatusBadge';

const meta = {
  title: 'Components/StatusBadge',
  component: StatusBadge,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof StatusBadge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Idle: Story = {
  args: { status: 'idle' },
};

export const Pending: Story = {
  args: { status: 'pending' },
};

export const Running: Story = {
  args: { status: 'running' },
};

export const SettingUp: Story = {
  args: { status: 'setting_up' },
};

export const Waiting: Story = {
  args: { status: 'waiting' },
};

export const Completed: Story = {
  args: { status: 'completed' },
};

export const Failed: Story = {
  args: { status: 'failed' },
};

export const Stopped: Story = {
  args: { status: 'stopped' },
};

export const Interrupted: Story = {
  args: { status: 'interrupted' },
};

export const AllStatuses: Story = {
  args: { status: 'idle' },
  render: () => (
    <div className="flex flex-wrap gap-3">
      <StatusBadge status="idle" />
      <StatusBadge status="pending" />
      <StatusBadge status="setting_up" />
      <StatusBadge status="running" />
      <StatusBadge status="waiting" />
      <StatusBadge status="completed" />
      <StatusBadge status="failed" />
      <StatusBadge status="stopped" />
      <StatusBadge status="interrupted" />
    </div>
  ),
};
