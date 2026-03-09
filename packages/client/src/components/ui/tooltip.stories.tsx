import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';

import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

const meta: Meta = {
  title: 'UI/Tooltip',
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <TooltipProvider>
        <Story />
      </TooltipProvider>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="outline">Hover me</Button>
      </TooltipTrigger>
      <TooltipContent>
        <p>This is a tooltip</p>
      </TooltipContent>
    </Tooltip>
  ),
};

export const Top: Story = {
  render: () => (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="outline">Top</Button>
      </TooltipTrigger>
      <TooltipContent side="top">
        <p>Tooltip on top</p>
      </TooltipContent>
    </Tooltip>
  ),
};

export const Right: Story = {
  render: () => (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="outline">Right</Button>
      </TooltipTrigger>
      <TooltipContent side="right">
        <p>Tooltip on right</p>
      </TooltipContent>
    </Tooltip>
  ),
};

export const Bottom: Story = {
  render: () => (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="outline">Bottom</Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <p>Tooltip on bottom</p>
      </TooltipContent>
    </Tooltip>
  ),
};

export const Left: Story = {
  render: () => (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="outline">Left</Button>
      </TooltipTrigger>
      <TooltipContent side="left">
        <p>Tooltip on left</p>
      </TooltipContent>
    </Tooltip>
  ),
};

// --- Interaction Tests ---

export const HoverShowsTooltip: Story = {
  render: () => (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="outline" data-testid="tooltip-trigger">
          Hover me
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        <p>Tooltip content</p>
      </TooltipContent>
    </Tooltip>
  ),
  play: async ({ canvas, userEvent }) => {
    const trigger = canvas.getByTestId('tooltip-trigger');
    // Hover to show tooltip
    await userEvent.hover(trigger);
    // Tooltip should appear (Radix renders in a portal, use findByText for async)
    const tooltip = await canvas.findByText('Tooltip content');
    await expect(tooltip).toBeVisible();
    // Unhover to hide
    await userEvent.unhover(trigger);
  },
};
