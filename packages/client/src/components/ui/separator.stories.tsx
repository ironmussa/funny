import type { Meta, StoryObj } from '@storybook/react-vite';

import { Separator } from '@/components/ui/separator';

const meta = {
  title: 'UI/Separator',
  component: Separator,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof Separator>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Horizontal: Story = {
  render: () => (
    <div className="w-64 space-y-3">
      <p className="text-sm text-foreground">Section above</p>
      <Separator />
      <p className="text-sm text-foreground">Section below</p>
    </div>
  ),
};

export const Vertical: Story = {
  render: () => (
    <div className="flex h-8 items-center gap-3">
      <span className="text-sm text-foreground">Left</span>
      <Separator orientation="vertical" />
      <span className="text-sm text-foreground">Right</span>
    </div>
  ),
};
