import type { Meta, StoryObj } from '@storybook/react-vite';

import { Input } from '@/components/ui/input';

const meta = {
  title: 'UI/Input',
  component: Input,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
  argTypes: {
    size: {
      control: 'select',
      options: ['default', 'xs', 'sm'],
    },
  },
} satisfies Meta<typeof Input>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { placeholder: 'Default input' },
};

export const ExtraSmall: Story = {
  args: { size: 'xs', placeholder: 'Extra small input' },
};

export const Small: Story = {
  args: { size: 'sm', placeholder: 'Small input' },
};

export const Disabled: Story = {
  args: { placeholder: 'Disabled input', disabled: true },
};

export const Password: Story = {
  args: { type: 'password', placeholder: 'Password' },
};

export const Email: Story = {
  args: { type: 'email', placeholder: 'email@example.com' },
};

export const File: Story = {
  args: { type: 'file' },
};

export const WithValue: Story = {
  args: { defaultValue: 'Hello World' },
};

export const AllSizes: Story = {
  args: { placeholder: '' },
  render: () => (
    <div className="flex w-64 flex-col gap-3">
      <Input size="xs" placeholder="Extra small" />
      <Input size="sm" placeholder="Small" />
      <Input size="default" placeholder="Default" />
    </div>
  ),
};
