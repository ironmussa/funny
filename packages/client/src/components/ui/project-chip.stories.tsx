import type { Meta, StoryObj } from '@storybook/react-vite';

import { ProjectChip } from '@/components/ui/project-chip';

const meta = {
  title: 'UI/ProjectChip',
  component: ProjectChip,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
  argTypes: {
    size: {
      control: 'select',
      options: ['sm', 'default'],
    },
  },
} satisfies Meta<typeof ProjectChip>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { name: 'funny' },
};

export const CustomColor: Story = {
  args: { name: 'my-project', color: '#e11d48' },
};

export const Small: Story = {
  args: { name: 'funny', size: 'sm' },
};

export const LongName: Story = {
  args: { name: 'very-long-project-name-that-should-truncate', className: 'max-w-32' },
};

export const MultipleColors: Story = {
  args: { name: 'frontend' },
  render: () => (
    <div className="flex flex-wrap gap-2">
      <ProjectChip name="frontend" color="#3b82f6" />
      <ProjectChip name="backend" color="#10b981" />
      <ProjectChip name="infra" color="#f59e0b" />
      <ProjectChip name="docs" color="#8b5cf6" />
      <ProjectChip name="tests" color="#ef4444" />
    </div>
  ),
};
