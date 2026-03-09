import type { Meta, StoryObj } from '@storybook/react-vite';

import { AppShellSkeleton } from '@/components/AppShellSkeleton';

const meta = {
  title: 'Components/AppShellSkeleton',
  component: AppShellSkeleton,
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
} satisfies Meta<typeof AppShellSkeleton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
