import type { Meta, StoryObj } from '@storybook/react-vite';

import { Skeleton } from '@/components/ui/skeleton';

const meta = {
  title: 'UI/Skeleton',
  component: Skeleton,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof Skeleton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Line: Story = {
  render: () => <Skeleton className="h-4 w-48" />,
};

export const Circle: Story = {
  render: () => <Skeleton className="size-12 rounded-full" />,
};

export const CardLayout: Story = {
  render: () => (
    <div className="flex items-center gap-4">
      <Skeleton className="size-12 rounded-full" />
      <div className="space-y-2">
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-4 w-32" />
      </div>
    </div>
  ),
};

export const FormLayout: Story = {
  render: () => (
    <div className="w-64 space-y-3">
      <Skeleton className="h-4 w-20" />
      <Skeleton className="h-10 w-full rounded-md" />
      <Skeleton className="h-4 w-24" />
      <Skeleton className="h-10 w-full rounded-md" />
      <Skeleton className="h-10 w-28 rounded-md" />
    </div>
  ),
};
