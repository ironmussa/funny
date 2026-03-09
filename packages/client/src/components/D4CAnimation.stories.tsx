import type { Meta, StoryObj } from '@storybook/react-vite';

import { D4CAnimation } from '@/components/D4CAnimation';

const meta = {
  title: 'Components/D4CAnimation',
  component: D4CAnimation,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
  argTypes: {
    size: {
      control: 'select',
      options: ['default', 'sm'],
    },
  },
} satisfies Meta<typeof D4CAnimation>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { size: 'default' },
};

export const Small: Story = {
  args: { size: 'sm' },
};

export const BothSizes: Story = {
  render: () => (
    <div className="flex items-center gap-6">
      <div className="flex flex-col items-center gap-2">
        <D4CAnimation size="default" />
        <span className="text-xs text-muted-foreground">Default</span>
      </div>
      <div className="flex flex-col items-center gap-2">
        <D4CAnimation size="sm" />
        <span className="text-xs text-muted-foreground">Small</span>
      </div>
    </div>
  ),
};
