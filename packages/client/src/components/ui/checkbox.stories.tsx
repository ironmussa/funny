import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';

import { Checkbox } from '@/components/ui/checkbox';

const meta = {
  title: 'UI/Checkbox',
  component: Checkbox,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof Checkbox>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Unchecked: Story = {
  args: {},
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

export const WithLabel: Story = {
  render: () => (
    <div className="flex items-center gap-2">
      <Checkbox id="terms" data-testid="checkbox-terms" />
      <label htmlFor="terms" className="text-sm font-medium text-foreground">
        Accept terms and conditions
      </label>
    </div>
  ),
};

export const ToggleOnOff: Story = {
  render: () => <Checkbox data-testid="checkbox-toggle" />,
  play: async ({ canvas, userEvent }) => {
    const checkbox = canvas.getByTestId('checkbox-toggle');
    await expect(checkbox).toHaveAttribute('data-state', 'unchecked');
    await userEvent.click(checkbox);
    await expect(checkbox).toHaveAttribute('data-state', 'checked');
    await userEvent.click(checkbox);
    await expect(checkbox).toHaveAttribute('data-state', 'unchecked');
  },
};

export const DisabledCannotToggle: Story = {
  render: () => <Checkbox disabled data-testid="checkbox-disabled" />,
  play: async ({ canvas }) => {
    const checkbox = canvas.getByTestId('checkbox-disabled');
    await expect(checkbox).toBeDisabled();
    await expect(checkbox).toHaveAttribute('data-state', 'unchecked');
  },
};
