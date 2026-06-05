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
      <p className="text-foreground text-sm">Section above</p>
      <Separator />
      <p className="text-foreground text-sm">Section below</p>
    </div>
  ),
};

export const Vertical: Story = {
  render: () => (
    <div className="flex h-8 items-center gap-3">
      <span className="text-foreground text-sm">Left</span>
      <Separator orientation="vertical" />
      <span className="text-foreground text-sm">Right</span>
    </div>
  ),
};
