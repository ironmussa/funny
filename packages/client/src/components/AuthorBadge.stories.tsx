import type { Meta, StoryObj } from '@storybook/react-vite';

import { AuthorBadge } from './AuthorBadge';

const meta = {
  title: 'Components/AuthorBadge',
  component: AuthorBadge,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
  argTypes: {
    size: {
      control: 'select',
      options: ['xs', 'sm'],
    },
    name: { control: 'text' },
    avatarUrl: { control: 'text' },
    email: { control: 'text' },
  },
} satisfies Meta<typeof AuthorBadge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WithPhoto: Story = {
  args: {
    name: 'shadcn',
    avatarUrl: 'https://github.com/shadcn.png',
    size: 'xs',
  },
};

export const WithGithubNoreplyEmail: Story = {
  args: {
    name: 'octocat',
    email: '1234+octocat@users.noreply.github.com',
    size: 'xs',
  },
};

export const WithGravatarEmail: Story = {
  args: {
    name: 'Jane Doe',
    email: 'jane.doe@example.com',
    size: 'xs',
  },
};

export const InitialsFallback: Story = {
  args: {
    name: 'Alice Walker',
    size: 'xs',
  },
};

export const SizeSm: Story = {
  args: {
    name: 'shadcn',
    avatarUrl: 'https://github.com/shadcn.png',
    size: 'sm',
  },
};

export const CustomLabel: Story = {
  args: {
    name: 'shadcn',
    avatarUrl: 'https://github.com/shadcn.png',
    size: 'xs',
  },
  render: (args) => (
    <AuthorBadge {...args}>
      <span className="font-semibold">shadcn</span>
      <span className="text-muted-foreground ml-1">· maintainer</span>
    </AuthorBadge>
  ),
};

export const Gallery: Story = {
  args: { name: 'Gallery' },
  render: () => (
    <div className="text-muted-foreground flex flex-col gap-2 text-[10px]">
      <AuthorBadge name="shadcn" avatarUrl="https://github.com/shadcn.png" size="xs" />
      <AuthorBadge name="octocat" email="1234+octocat@users.noreply.github.com" size="xs" />
      <AuthorBadge name="Jane Doe" email="jane.doe@example.com" size="xs" />
      <AuthorBadge name="Alice Walker" size="xs" />
      <AuthorBadge name="shadcn" avatarUrl="https://github.com/shadcn.png" size="sm" />
    </div>
  ),
};
