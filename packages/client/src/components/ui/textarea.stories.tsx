import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';

import { Textarea } from '@/components/ui/textarea';

const meta = {
  title: 'UI/Textarea',
  component: Textarea,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
  args: {
    onChange: fn(),
  },
  argTypes: {
    size: {
      control: 'select',
      options: ['default', 'xs', 'sm'],
    },
  },
} satisfies Meta<typeof Textarea>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { placeholder: 'Type your message here...' },
};

export const ExtraSmall: Story = {
  args: { placeholder: 'Extra small textarea...', size: 'xs' },
};

export const Small: Story = {
  args: { placeholder: 'Small textarea...', size: 'sm' },
};

export const WithValue: Story = {
  args: { defaultValue: 'This textarea already has some content in it.' },
};

export const Disabled: Story = {
  args: { placeholder: 'Disabled textarea', disabled: true },
};

export const WithRows: Story = {
  args: { placeholder: 'Taller textarea...', rows: 6 },
};

export const AllSizes: Story = {
  render: () => (
    <div className="flex w-80 flex-col gap-4">
      <Textarea data-testid="textarea-xs" size="xs" placeholder="Extra Small (xs)" />
      <Textarea data-testid="textarea-sm" size="sm" placeholder="Small (sm)" />
      <Textarea data-testid="textarea-default" size="default" placeholder="Default" />
    </div>
  ),
};

export const WithLabel: Story = {
  render: () => (
    <div className="grid w-full max-w-sm gap-1.5">
      <label htmlFor="message" className="text-foreground text-sm font-medium">
        Message
      </label>
      <Textarea id="message" placeholder="Type your message here..." />
      <p className="text-muted-foreground text-xs">Enter your message above.</p>
    </div>
  ),
};
