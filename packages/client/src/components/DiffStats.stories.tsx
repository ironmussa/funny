import type { Meta, StoryObj } from '@storybook/react-vite';

import '@/i18n/config';
import { TooltipProvider } from '@/components/ui/tooltip';

import { DiffStats } from './DiffStats';

const meta = {
  title: 'Components/DiffStats',
  component: DiffStats,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <TooltipProvider>
        <Story />
      </TooltipProvider>
    ),
  ],
} satisfies Meta<typeof DiffStats>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  name: 'Default (sm)',
  args: {
    linesAdded: 5603,
    linesDeleted: 1137,
    dirtyFileCount: 48,
  },
};

export const ExtraSmall: Story = {
  name: 'Extra Small (xs)',
  args: {
    linesAdded: 5603,
    linesDeleted: 1137,
    dirtyFileCount: 48,
    size: 'xs',
  },
};

export const AdditionsOnly: Story = {
  name: 'Additions Only',
  args: {
    linesAdded: 230,
    linesDeleted: 0,
    dirtyFileCount: 5,
  },
};

export const DeletionsOnly: Story = {
  name: 'Deletions Only',
  args: {
    linesAdded: 0,
    linesDeleted: 87,
    dirtyFileCount: 3,
  },
};

export const SmallChanges: Story = {
  name: 'Small Changes',
  args: {
    linesAdded: 3,
    linesDeleted: 1,
    dirtyFileCount: 1,
  },
};

export const NoFileCount: Story = {
  name: 'Without File Count',
  args: {
    linesAdded: 42,
    linesDeleted: 18,
  },
};

export const NoTooltips: Story = {
  name: 'Without Tooltips',
  args: {
    linesAdded: 100,
    linesDeleted: 50,
    dirtyFileCount: 10,
    tooltips: false,
  },
};

export const ZeroValues: Story = {
  name: 'Zero Values (hidden)',
  args: {
    linesAdded: 0,
    linesDeleted: 0,
    dirtyFileCount: 0,
  },
};

export const ExtraExtraSmall: Story = {
  name: 'Extra Extra Small (xxs)',
  args: {
    linesAdded: 5603,
    linesDeleted: 1137,
    dirtyFileCount: 48,
    size: 'xxs',
  },
};

export const AllSizes: Story = {
  name: 'All Sizes',
  args: {
    linesAdded: 5603,
    linesDeleted: 1137,
    dirtyFileCount: 48,
  },
  render: () => (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <span className="text-muted-foreground w-16 text-xs">sm</span>
        <DiffStats linesAdded={5603} linesDeleted={1137} dirtyFileCount={48} size="sm" />
      </div>
      <div className="flex items-center gap-3">
        <span className="text-muted-foreground w-16 text-xs">xs</span>
        <DiffStats linesAdded={5603} linesDeleted={1137} dirtyFileCount={48} size="xs" />
      </div>
      <div className="flex items-center gap-3">
        <span className="text-muted-foreground w-16 text-xs">xxs</span>
        <DiffStats linesAdded={5603} linesDeleted={1137} dirtyFileCount={48} size="xxs" />
      </div>
    </div>
  ),
};
