import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';

import { Switch } from '@/components/ui/switch';

const meta = {
  title: 'UI/Switch',
  component: Switch,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
  argTypes: {
    size: {
      control: 'select',
      options: ['default', 'sm', 'xs'],
    },
  },
} satisfies Meta<typeof Switch>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {},
};

export const ExtraSmall: Story = {
  args: { size: 'xs' },
};

export const Small: Story = {
  args: { size: 'sm' },
};

export const Checked: Story = {
  args: { defaultChecked: true },
};

export const Disabled: Story = {
  args: { disabled: true },
};

export const DisabledChecked: Story = {
  args: { disabled: true, defaultChecked: true },
};

export const AllSizes: Story = {
  render: () => (
    <div className="flex items-center gap-6">
      <div className="flex flex-col items-center gap-1">
        <Switch data-testid="switch-xs" size="xs" />
        <span className="text-xs text-muted-foreground">xs</span>
      </div>
      <div className="flex flex-col items-center gap-1">
        <Switch data-testid="switch-sm" size="sm" />
        <span className="text-xs text-muted-foreground">sm</span>
      </div>
      <div className="flex flex-col items-center gap-1">
        <Switch data-testid="switch-default" size="default" />
        <span className="text-xs text-muted-foreground">default</span>
      </div>
    </div>
  ),
};

export const WithLabel: Story = {
  render: () => (
    <div className="flex items-center gap-2">
      <Switch id="airplane-mode" data-testid="switch-label" />
      <label htmlFor="airplane-mode" className="text-sm font-medium text-foreground">
        Airplane Mode
      </label>
    </div>
  ),
};

export const ToggleOnOff: Story = {
  render: () => <Switch data-testid="switch-toggle" />,
  play: async ({ canvas, userEvent }) => {
    const toggle = canvas.getByTestId('switch-toggle');
    await expect(toggle).toHaveAttribute('data-state', 'unchecked');
    await userEvent.click(toggle);
    await expect(toggle).toHaveAttribute('data-state', 'checked');
    await userEvent.click(toggle);
    await expect(toggle).toHaveAttribute('data-state', 'unchecked');
  },
};
