import type { Meta, StoryObj } from '@storybook/react-vite';

import { CopyButton } from '@/components/ui/copy-button';

const meta = {
  title: 'UI/CopyButton',
  component: CopyButton,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
  argTypes: {
    variant: {
      control: 'select',
      options: ['default', 'destructive', 'outline', 'secondary', 'ghost', 'link'],
    },
    size: {
      control: 'select',
      options: ['default', 'xs', 'sm', 'lg', 'icon', 'icon-xs', 'icon-sm'],
    },
  },
} satisfies Meta<typeof CopyButton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { value: 'Hello, world!' },
};

export const WithCustomLabels: Story = {
  args: {
    value: 'npm install funny',
    label: 'Copy command',
    copiedLabel: 'Command copied!',
  },
};

export const InContext: Story = {
  args: { value: 'bunx funny' },
  render: (args) => (
    <div className="flex items-center gap-2 rounded-md border border-border px-3 py-2">
      <code className="text-sm text-foreground">bunx funny</code>
      <CopyButton {...args} />
    </div>
  ),
};

export const Sizes: Story = {
  args: { value: 'copied text' },
  render: () => (
    <div className="flex items-center gap-4">
      <CopyButton value="xs" size="icon-xs" />
      <CopyButton value="sm" size="icon-sm" />
      <CopyButton value="default" size="icon" />
    </div>
  ),
};
