import type { Meta, StoryObj } from '@storybook/react-vite';
import { useRef } from 'react';
import { fn } from 'storybook/test';

import '@/i18n/config';
import { TooltipProvider } from '@/components/ui/tooltip';

import { AgentInterruptedCard, AgentResultCard, AgentStoppedCard } from './AgentStatusCards';
import { useTurnEndHover } from './use-turn-end-hover';

const STARTED_AT = '2026-10-30T20:40:00.000Z';
const COMPLETED_AT = '2026-10-30T20:41:44.000Z';
const TURN = [
  { id: 'u1', role: 'user', content: 'Fix the flaky test' },
  { id: 'a1', role: 'assistant', content: 'Fixed by flushing the pending timer.' },
] as any[];

const meta = {
  title: 'Thread/AgentResultCard',
  component: AgentResultCard,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <TooltipProvider>
        <div className="w-[640px] min-w-0">
          <Story />
        </div>
      </TooltipProvider>
    ),
  ],
  args: {
    status: 'completed',
    cost: 0,
    duration: 0,
    startedAt: STARTED_AT,
    completedAt: COMPLETED_AT,
    copyThreadId: 'thread-1',
    copyMessages: TURN,
  },
} satisfies Meta<typeof AgentResultCard>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Completion time with seconds on the left; duration and copy on the right. */
export const Completed: Story = {};

export const Failed: Story = {
  args: { status: 'failed', error: 'Process exited with code 1', onContinue: fn() },
};

function HoverRevealDemo(args: Story['args']) {
  const ref = useRef<HTMLDivElement>(null);
  useTurnEndHover(ref);
  return (
    <div ref={ref} className="space-y-1">
      <div data-turn-section="u1" className="text-muted-foreground rounded border p-3 text-sm">
        Hover this answer to reveal its completion bar.
      </div>
      <div data-turn-section="u1">
        <AgentResultCard {...(args as any)} revealForSection="u1" />
      </div>
    </div>
  );
}

/** Completed bars stay hidden until their turn is hovered (always shown on touch). */
export const RevealOnHover: Story = {
  render: (args) => <HoverRevealDemo {...args} />,
};

export const Stopped: Story = {
  render: (args) => (
    <AgentStoppedCard
      onContinue={fn()}
      startedAt={args.startedAt}
      completedAt={args.completedAt}
      copyThreadId={args.copyThreadId}
      copyMessages={args.copyMessages}
    />
  ),
};

export const Interrupted: Story = {
  render: (args) => (
    <AgentInterruptedCard
      onContinue={fn()}
      startedAt={args.startedAt}
      completedAt={args.completedAt}
      copyThreadId={args.copyThreadId}
      copyMessages={args.copyMessages}
    />
  ),
};
