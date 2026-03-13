import type { Meta, StoryObj } from '@storybook/react-vite';
import { Mail, Plus } from 'lucide-react';
import { expect, fn } from 'storybook/test';

import { Button } from '@/components/ui/button';

const meta = {
  title: 'UI/Button',
  component: Button,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
  args: {
    onClick: fn(),
  },
  argTypes: {
    variant: {
      control: 'select',
      options: ['default', 'destructive', 'outline', 'secondary', 'ghost', 'link'],
    },
    size: {
      control: 'select',
      options: ['default', 'xs', 'sm', 'lg', 'icon', 'icon-xs', 'icon-sm'],
    },
  },
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { children: 'Button' },
};

export const Destructive: Story = {
  args: { variant: 'destructive', children: 'Delete' },
};

export const Outline: Story = {
  args: { variant: 'outline', children: 'Outline' },
};

export const Secondary: Story = {
  args: { variant: 'secondary', children: 'Secondary' },
};

export const Ghost: Story = {
  args: { variant: 'ghost', children: 'Ghost' },
};

export const Link: Story = {
  args: { variant: 'link', children: 'Link' },
};

export const ExtraSmall: Story = {
  args: { size: 'xs', children: 'Extra Small' },
};

export const Small: Story = {
  args: { size: 'sm', children: 'Small' },
};

export const Large: Story = {
  args: { size: 'lg', children: 'Large' },
};

export const Icon: Story = {
  args: { size: 'icon', children: <Plus /> },
};

export const IconSmall: Story = {
  args: { size: 'icon-sm', children: <Plus /> },
};

export const IconExtraSmall: Story = {
  args: { size: 'icon-xs', children: <Plus /> },
};

export const Loading: Story = {
  args: { loading: true, children: 'Saving...' },
};

export const Disabled: Story = {
  args: { disabled: true, children: 'Disabled' },
};

export const WithIcon: Story = {
  args: {
    children: (
      <>
        <Mail /> Send Email
      </>
    ),
  },
};

export const AllVariants: Story = {
  render: () => (
    <div className="flex flex-wrap gap-4">
      <Button variant="default">Default</Button>
      <Button variant="destructive">Destructive</Button>
      <Button variant="outline">Outline</Button>
      <Button variant="secondary">Secondary</Button>
      <Button variant="ghost">Ghost</Button>
      <Button variant="link">Link</Button>
    </div>
  ),
};

export const AllSizes: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-4">
      <Button size="xs">Extra Small</Button>
      <Button size="sm">Small</Button>
      <Button size="default">Default</Button>
      <Button size="lg">Large</Button>
      <Button size="icon">
        <Plus />
      </Button>
      <Button size="icon-sm">
        <Plus />
      </Button>
      <Button size="icon-xs">
        <Plus />
      </Button>
    </div>
  ),
};

// --- Interaction Tests ---

export const ClickTest: Story = {
  args: { children: 'Click me' },
  play: async ({ args, canvas, userEvent }) => {
    const button = canvas.getByRole('button', { name: 'Click me' });
    await userEvent.click(button);
    await expect(args.onClick).toHaveBeenCalledTimes(1);
  },
};

export const DisabledNotClickable: Story = {
  args: { children: 'Disabled', disabled: true },
  play: async ({ args, canvas }) => {
    const button = canvas.getByRole('button', { name: 'Disabled' });
    await expect(button).toBeDisabled();
    await expect(args.onClick).not.toHaveBeenCalled();
  },
};

export const LoadingDisablesButton: Story = {
  args: { children: 'Saving...', loading: true },
  play: async ({ args, canvas }) => {
    const button = canvas.getByRole('button', { name: 'Saving...' });
    await expect(button).toBeDisabled();
    await expect(args.onClick).not.toHaveBeenCalled();
  },
};
