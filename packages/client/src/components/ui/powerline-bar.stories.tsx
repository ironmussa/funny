import type { Meta, StoryObj } from '@storybook/react-vite';
import { Folder, GitBranch, Globe, Server } from 'lucide-react';

import { PowerlineBar } from '@/components/ui/powerline-bar';

const meta = {
  title: 'UI/PowerlineBar',
  component: PowerlineBar,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
  argTypes: {
    variant: {
      control: 'select',
      options: ['arrow', 'chips', 'plain'],
    },
    size: {
      control: 'select',
      options: ['sm', 'md'],
    },
  },
} satisfies Meta<typeof PowerlineBar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    segments: [
      { key: 'project', icon: Folder, label: 'funny', color: '#7CB9E8', tooltip: 'Project: funny' },
      { key: 'branch', icon: GitBranch, label: 'main', color: '#5A9BD5', tooltip: 'Branch: main' },
    ],
  },
};

export const ArrowVariant: Story = {
  args: {
    variant: 'arrow',
    segments: [
      { key: 'project', icon: Folder, label: 'funny', color: '#7CB9E8' },
      { key: 'branch', icon: GitBranch, label: 'main', color: '#5A9BD5' },
      { key: 'worktree', icon: GitBranch, label: 'feat/new-feature', color: '#3D7EAA' },
    ],
  },
};

export const ChipsVariant: Story = {
  args: {
    variant: 'chips',
    segments: [
      { key: 'project', icon: Folder, label: 'funny', color: '#7CB9E8' },
      { key: 'branch', icon: GitBranch, label: 'main', color: '#5A9BD5' },
      { key: 'worktree', icon: GitBranch, label: 'feat/new-feature', color: '#3D7EAA' },
    ],
  },
};

export const PlainVariant: Story = {
  args: {
    variant: 'plain',
    segments: [
      { key: 'project', icon: Folder, label: 'funny', color: '#7CB9E8' },
      { key: 'branch', icon: GitBranch, label: 'main', color: '#5A9BD5' },
      { key: 'worktree', icon: GitBranch, label: 'feat/new-feature', color: '#3D7EAA' },
    ],
  },
};

export const SingleSegment: Story = {
  args: {
    segments: [{ key: 'branch', icon: GitBranch, label: 'main', color: '#10b981' }],
  },
};

export const SmallSize: Story = {
  args: {
    size: 'sm',
    segments: [
      { key: 'project', icon: Folder, label: 'backend', color: '#f59e0b' },
      { key: 'branch', icon: GitBranch, label: 'develop', color: '#d97706' },
    ],
  },
};

export const MediumSize: Story = {
  args: {
    size: 'md',
    segments: [
      { key: 'project', icon: Folder, label: 'backend', color: '#f59e0b' },
      { key: 'branch', icon: GitBranch, label: 'develop', color: '#d97706' },
    ],
  },
};

export const CustomTextColor: Story = {
  args: {
    segments: [
      { key: 'env', icon: Globe, label: 'production', color: '#dc2626', textColor: '#ffffff' },
      { key: 'server', icon: Server, label: 'us-east-1', color: '#991b1b', textColor: '#fecaca' },
    ],
  },
};

export const LongLabels: Story = {
  args: {
    className: 'max-w-64',
    segments: [
      { key: 'project', icon: Folder, label: 'my-very-long-project-name', color: '#8b5cf6' },
      {
        key: 'branch',
        icon: GitBranch,
        label: 'feat/implement-powerline-component-stories',
        color: '#6d28d9',
      },
    ],
  },
};

export const ManySegments: Story = {
  args: {
    segments: [
      { key: 'org', label: 'acme-corp', color: '#3b82f6' },
      { key: 'project', icon: Folder, label: 'frontend', color: '#2563eb' },
      { key: 'branch', icon: GitBranch, label: 'main', color: '#1d4ed8' },
      { key: 'worktree', icon: GitBranch, label: 'feat/auth', color: '#1e40af' },
    ],
  },
};

export const VariantsComparison: Story = {
  args: {
    segments: [
      { key: 'project', icon: Folder, label: 'funny', color: '#7CB9E8' },
      { key: 'branch', icon: GitBranch, label: 'main', color: '#5A9BD5' },
    ],
  },
  render: () => {
    const segments = [
      { key: 'project', icon: Folder, label: 'funny', color: '#7CB9E8' },
      { key: 'branch', icon: GitBranch, label: 'main', color: '#5A9BD5' },
      { key: 'worktree', icon: GitBranch, label: 'feat/auth', color: '#3D7EAA' },
    ];
    return (
      <div className="flex flex-col gap-4">
        <div>
          <p className="mb-2 text-xs text-muted-foreground">Arrow (md)</p>
          <PowerlineBar segments={segments} variant="arrow" size="md" />
        </div>
        <div>
          <p className="mb-2 text-xs text-muted-foreground">Arrow (sm)</p>
          <PowerlineBar segments={segments} variant="arrow" size="sm" />
        </div>
        <div>
          <p className="mb-2 text-xs text-muted-foreground">Chips (md)</p>
          <PowerlineBar segments={segments} variant="chips" size="md" />
        </div>
        <div>
          <p className="mb-2 text-xs text-muted-foreground">Chips (sm)</p>
          <PowerlineBar segments={segments} variant="chips" size="sm" />
        </div>
      </div>
    );
  },
};

export const ColorPalettes: Story = {
  args: {
    segments: [
      { key: 'project', icon: Folder, label: 'frontend', color: '#3b82f6' },
      { key: 'branch', icon: GitBranch, label: 'main', color: '#2563eb' },
    ],
  },
  render: () => (
    <div className="flex flex-col gap-3">
      <PowerlineBar
        variant="arrow"
        segments={[
          { key: 'p', icon: Folder, label: 'frontend', color: '#3b82f6' },
          { key: 'b', icon: GitBranch, label: 'main', color: '#2563eb' },
        ]}
      />
      <PowerlineBar
        variant="arrow"
        segments={[
          { key: 'p', icon: Folder, label: 'backend', color: '#10b981' },
          { key: 'b', icon: GitBranch, label: 'develop', color: '#059669' },
        ]}
      />
      <PowerlineBar
        variant="arrow"
        segments={[
          { key: 'p', icon: Folder, label: 'infra', color: '#f59e0b' },
          { key: 'b', icon: GitBranch, label: 'release/v2', color: '#d97706' },
        ]}
      />
      <PowerlineBar
        variant="arrow"
        segments={[
          { key: 'p', icon: Folder, label: 'docs', color: '#8b5cf6' },
          { key: 'b', icon: GitBranch, label: 'fix/typos', color: '#7c3aed' },
        ]}
      />
      <PowerlineBar
        variant="arrow"
        segments={[
          { key: 'p', icon: Folder, label: 'api', color: '#ef4444' },
          { key: 'b', icon: GitBranch, label: 'hotfix/auth', color: '#dc2626' },
        ]}
      />
    </div>
  ),
};
