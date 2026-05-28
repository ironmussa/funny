import type { Meta, StoryObj } from '@storybook/react-vite';

import { LoadingState } from '@/components/ui/loading-state';

const meta = {
  title: 'UI/LoadingState',
  component: LoadingState,
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
  argTypes: {
    size: { control: 'select', options: ['default', 'compact'] },
    layout: { control: 'select', options: ['stack', 'inline'] },
    fill: { control: 'boolean' },
  },
} satisfies Meta<typeof LoadingState>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    label: 'Loading…',
    testId: 'loading-default',
  },
  render: (args) => (
    <div className="h-64 w-full max-w-2xl border border-border bg-background">
      <LoadingState {...args} />
    </div>
  ),
};

export const Preparing: Story = {
  args: {
    label: 'Preparing…',
    testId: 'loading-preparing',
  },
  render: (args) => (
    <div className="h-64 w-full max-w-2xl border border-border bg-background">
      <LoadingState {...args} />
    </div>
  ),
};

export const Compact: Story = {
  args: {
    size: 'compact',
    label: 'Loading changes…',
    testId: 'loading-compact',
  },
  render: (args) => (
    <div className="h-48 w-72 border border-border bg-background">
      <LoadingState {...args} />
    </div>
  ),
};

export const Inline: Story = {
  args: {
    layout: 'inline',
    size: 'compact',
    fill: false,
    label: 'Loading older messages…',
    testId: 'loading-inline',
  },
  render: (args) => (
    <div className="flex w-full max-w-2xl justify-center border border-border bg-background py-6">
      <LoadingState {...args} />
    </div>
  ),
};

export const Overlay: Story = {
  args: {
    fill: false,
    testId: 'loading-overlay',
  },
  render: (args) => (
    <div className="relative h-64 w-full max-w-2xl border border-border bg-background">
      <div className="p-4 text-sm text-muted-foreground">Content behind overlay…</div>
      <div className="pointer-events-none absolute inset-0 flex items-start justify-center bg-background/40 pt-16">
        <LoadingState {...args} />
      </div>
    </div>
  ),
};

export const MainAndSidebar: Story = {
  render: () => (
    <div className="flex h-72 w-full max-w-4xl border border-border bg-background">
      <div className="flex min-w-0 flex-1 border-r border-border">
        <LoadingState testId="loading-main-column" label="Preparing…" />
      </div>
      <div className="flex w-72 shrink-0 flex-col">
        <div className="border-b border-border px-3 py-2 text-xs text-muted-foreground">
          Changes
        </div>
        <LoadingState testId="loading-sidebar" label="Loading changes…" />
      </div>
    </div>
  ),
};

export const SpinnerOnly: Story = {
  args: {
    fill: false,
    testId: 'loading-spinner-only',
  },
  render: (args) => (
    <div className="flex h-32 w-full max-w-md items-center justify-center border border-border bg-background">
      <LoadingState {...args} />
    </div>
  ),
};
