import type { Meta, StoryObj } from '@storybook/react-vite';

import '@/i18n/config';
import { TodoList } from './TodoList';

const meta = {
  title: 'ToolCards/TodoList',
  component: TodoList,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
} satisfies Meta<typeof TodoList>;

export default meta;
type Story = StoryObj<typeof meta>;

/** All tasks pending */
export const AllPending: Story = {
  name: 'All Pending',
  args: {
    todos: [
      { content: 'Set up database schema', status: 'pending' },
      { content: 'Create API routes', status: 'pending' },
      { content: 'Add authentication middleware', status: 'pending' },
      { content: 'Write unit tests', status: 'pending' },
    ],
  },
};

/** Mix of statuses — typical in-progress state */
export const InProgress: Story = {
  name: 'In Progress',
  args: {
    todos: [
      { content: 'Set up database schema', status: 'completed' },
      { content: 'Create API routes', status: 'completed' },
      { content: 'Add authentication middleware', status: 'in_progress' },
      { content: 'Write unit tests', status: 'pending' },
      { content: 'Deploy to staging', status: 'pending' },
    ],
  },
};

/** All tasks completed */
export const AllCompleted: Story = {
  name: 'All Completed',
  args: {
    todos: [
      { content: 'Set up database schema', status: 'completed' },
      { content: 'Create API routes', status: 'completed' },
      { content: 'Add authentication middleware', status: 'completed' },
      { content: 'Write unit tests', status: 'completed' },
    ],
  },
};

/** Single item */
export const SingleItem: Story = {
  name: 'Single Item',
  args: {
    todos: [{ content: 'Fix the login bug reported in issue #42', status: 'in_progress' }],
  },
};

/** Long task descriptions */
export const LongDescriptions: Story = {
  name: 'Long Descriptions',
  args: {
    todos: [
      {
        content:
          'Refactor the authentication middleware to support both bearer token and session cookie validation, ensuring backward compatibility with existing API consumers',
        status: 'completed',
      },
      {
        content:
          'Update the WebSocket broker to filter events per user in multi-user mode, preventing cross-user data leakage',
        status: 'in_progress',
      },
      {
        content:
          'Add comprehensive E2E tests using Playwright for the new invite links flow, covering accept, reject, and expired link scenarios',
        status: 'pending',
      },
    ],
  },
};
