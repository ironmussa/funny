import type { Meta, StoryObj } from '@storybook/react-vite';
import { Inbox, Zap, Bell, Settings, Search } from 'lucide-react';

import { NavItem } from './nav-item';

const meta = {
  title: 'UI/NavItem',
  component: NavItem,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <div className="w-[260px]">
        <Story />
      </div>
    ),
  ],
  argTypes: {
    icon: { control: false },
    size: { control: 'radio', options: ['sm', 'md'] },
  },
} satisfies Meta<typeof NavItem>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    icon: Inbox,
    label: 'Inbox',
  },
};

export const WithCount: Story = {
  name: 'With Count',
  args: {
    icon: Inbox,
    label: 'Inbox',
    count: 5,
  },
};

export const Active: Story = {
  args: {
    icon: Inbox,
    label: 'Inbox',
    count: 3,
    isActive: true,
  },
};

export const Small: Story = {
  name: 'Small',
  args: {
    icon: Inbox,
    label: 'Inbox',
    count: 5,
    size: 'sm',
  },
};

export const SmallActive: Story = {
  name: 'Small Active',
  args: {
    icon: Zap,
    label: 'Automations',
    count: 2,
    size: 'sm',
    isActive: true,
  },
};

export const ZeroCount: Story = {
  name: 'Zero Count (badge hidden)',
  args: {
    icon: Bell,
    label: 'Notifications',
    count: 0,
  },
};

/** All sizes and states stacked for visual comparison. */
export const SizeComparison: Story = {
  name: 'Size Comparison',
  args: { icon: Inbox, label: 'Inbox' },
  render: () => (
    <div className="flex flex-col gap-4">
      <div>
        <p className="mb-1 text-xs text-muted-foreground">md (default)</p>
        <div className="flex flex-col">
          <NavItem icon={Inbox} label="Inbox" count={3} />
          <NavItem icon={Zap} label="Automations" isActive />
          <NavItem icon={Bell} label="Notifications" count={12} />
          <NavItem icon={Search} label="Search" />
          <NavItem icon={Settings} label="Settings" />
        </div>
      </div>
      <div>
        <p className="mb-1 text-xs text-muted-foreground">sm</p>
        <div className="flex flex-col">
          <NavItem icon={Inbox} label="Inbox" count={3} size="sm" />
          <NavItem icon={Zap} label="Automations" isActive size="sm" />
          <NavItem icon={Bell} label="Notifications" count={12} size="sm" />
          <NavItem icon={Search} label="Search" size="sm" />
          <NavItem icon={Settings} label="Settings" size="sm" />
        </div>
      </div>
    </div>
  ),
};
