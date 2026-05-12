import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useState } from 'react';

import type { GitProgressStep } from '@/lib/git-progress-types';

import { WorktreeSetupProgress } from './WorktreeSetupProgress';

const meta: Meta<typeof WorktreeSetupProgress> = {
  title: 'Components/WorktreeSetupProgress',
  component: WorktreeSetupProgress,
  parameters: {
    layout: 'centered',
  },
  decorators: [
    (Story) => (
      <div className="flex h-[400px] w-[600px] items-center justify-center">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof WorktreeSetupProgress>;

// --- Static scenarios ---

export const EmptyState: Story = {
  args: {
    steps: [],
  },
};

export const SingleStepRunning: Story = {
  args: {
    steps: [{ id: 'worktree', label: 'Creating worktree', status: 'running' }],
  },
};

export const SingleStepCompleted: Story = {
  args: {
    steps: [{ id: 'worktree', label: 'Creating worktree', status: 'completed' }],
  },
};

export const MultipleStepsMidway: Story = {
  args: {
    steps: [
      { id: 'worktree', label: 'Creating worktree', status: 'completed' },
      { id: 'ports', label: 'Allocating ports', status: 'running' },
      { id: 'cmd:bun install', label: 'bun install', status: 'pending' },
    ],
  },
};

export const AllCompleted: Story = {
  args: {
    steps: [
      { id: 'worktree', label: 'Creating worktree', status: 'completed' },
      { id: 'ports', label: 'Allocating ports', status: 'completed' },
      { id: 'cmd:bun install', label: 'bun install', status: 'completed' },
    ],
  },
};

export const WithError: Story = {
  args: {
    steps: [
      { id: 'worktree', label: 'Creating worktree', status: 'completed' },
      {
        id: 'ports',
        label: 'Allocating ports',
        status: 'failed',
        error: 'EADDRINUSE: port 3000 already in use',
      },
    ],
  },
};

export const ManySteps: Story = {
  args: {
    steps: [
      { id: 'worktree', label: 'Creating worktree', status: 'completed' },
      { id: 'ports', label: 'Allocating ports', status: 'completed' },
      { id: 'cmd:bun install', label: 'bun install', status: 'completed' },
      { id: 'cmd:bun run build', label: 'bun run build', status: 'running' },
      { id: 'cmd:bun run migrate', label: 'bun run migrate', status: 'pending' },
    ],
  },
};

// --- Interactive simulation ---

function LiveSimulationStory() {
  const allSteps: GitProgressStep[] = [
    { id: 'worktree', label: 'Creating worktree', status: 'pending' },
    { id: 'ports', label: 'Allocating ports', status: 'pending' },
    { id: 'cmd:bun install', label: 'bun install', status: 'pending' },
    { id: 'cmd:bun run build', label: 'bun run build', status: 'pending' },
  ];

  const [steps, setSteps] = useState<GitProgressStep[]>([{ ...allSteps[0], status: 'running' }]);

  useEffect(() => {
    const timers = [
      // Step 1 completes, step 2 starts
      setTimeout(
        () =>
          setSteps([
            { ...allSteps[0], status: 'completed' },
            { ...allSteps[1], status: 'running' },
            { ...allSteps[2], status: 'pending' },
            { ...allSteps[3], status: 'pending' },
          ]),
        2000,
      ),
      // Step 2 completes, step 3 starts
      setTimeout(
        () =>
          setSteps([
            { ...allSteps[0], status: 'completed' },
            { ...allSteps[1], status: 'completed' },
            { ...allSteps[2], status: 'running' },
            { ...allSteps[3], status: 'pending' },
          ]),
        3500,
      ),
      // Step 3 completes, step 4 starts
      setTimeout(
        () =>
          setSteps([
            { ...allSteps[0], status: 'completed' },
            { ...allSteps[1], status: 'completed' },
            { ...allSteps[2], status: 'completed' },
            { ...allSteps[3], status: 'running' },
          ]),
        6000,
      ),
      // All done
      setTimeout(
        () =>
          setSteps([
            { ...allSteps[0], status: 'completed' },
            { ...allSteps[1], status: 'completed' },
            { ...allSteps[2], status: 'completed' },
            { ...allSteps[3], status: 'completed' },
          ]),
        8000,
      ),
    ];
    return () => {
      for (const t of timers) clearTimeout(t);
    };
  }, []);

  return <WorktreeSetupProgress steps={steps} />;
}

export const LiveSimulation: Story = {
  render: () => <LiveSimulationStory />,
};
