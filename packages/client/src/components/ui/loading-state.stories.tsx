import type { Meta, StoryObj } from '@storybook/react-vite';
import { Inbox } from 'lucide-react';

import { EmptyState } from '@/components/ui/empty-state';
import { LoadingState } from '@/components/ui/loading-state';

const meta = {
  title: 'UI/LoadingState',
  component: LoadingState,
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
  argTypes: {
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
    <div className="border-border bg-background h-64 w-full max-w-2xl border">
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
    <div className="border-border bg-background h-64 w-full max-w-2xl border">
      <LoadingState {...args} />
    </div>
  ),
};

export const NarrowPanel: Story = {
  args: {
    label: 'Loading changes…',
    testId: 'loading-narrow-panel',
  },
  render: (args) => (
    <div className="border-border bg-background h-48 w-72 border">
      <LoadingState {...args} />
    </div>
  ),
};

export const Inline: Story = {
  args: {
    layout: 'inline',
    fill: false,
    label: 'Loading older messages…',
    testId: 'loading-inline',
  },
  render: (args) => (
    <div className="border-border bg-background flex w-full max-w-2xl justify-center border py-6">
      <LoadingState {...args} />
    </div>
  ),
};

/** Both orientations share the same spinner, typography, and spacing. */
export const LayoutComparison: Story = {
  args: {
    label: 'Loading…',
  },
  render: (args) => (
    <div className="border-border bg-background grid h-64 grid-cols-2 divide-x border">
      <LoadingState {...args} layout="stack" />
      <LoadingState {...args} layout="inline" />
    </div>
  ),
};

export const Overlay: Story = {
  args: {
    fill: false,
    testId: 'loading-overlay',
  },
  render: (args) => (
    <div className="border-border bg-background relative h-64 w-full max-w-2xl border">
      <div className="text-muted-foreground p-4 text-sm">Content behind overlay…</div>
      <div className="bg-background/40 pointer-events-none absolute inset-0 flex items-start justify-center pt-16">
        <LoadingState {...args} />
      </div>
    </div>
  ),
};

export const MainAndSidebar: Story = {
  render: () => (
    <div className="border-border bg-background flex h-72 w-full max-w-4xl border">
      <div className="border-border flex min-w-0 flex-1 border-r">
        <LoadingState testId="loading-main-column" label="Preparing…" />
      </div>
      <div className="flex w-72 shrink-0 flex-col">
        <div className="border-border text-muted-foreground border-b px-3 py-2 text-xs">
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
    <div className="border-border bg-background flex h-32 w-full max-w-md items-center justify-center border">
      <LoadingState {...args} />
    </div>
  ),
};

/** Loading and empty placeholders must keep the same icon and text scale. */
export const LoadingAndEmpty: Story = {
  render: () => (
    <div className="bg-background grid h-64 grid-cols-2">
      <LoadingState label="Loading files…" />
      <EmptyState icon={Inbox} title="No files yet" description="Add a file to get started." />
    </div>
  ),
};
