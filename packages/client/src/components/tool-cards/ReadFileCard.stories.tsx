import type { Meta, StoryObj } from '@storybook/react-vite';

import '@/i18n/config';
import { ThreadProvider } from '@/stores/thread-context';

import { ReadFileCard } from './ReadFileCard';

const meta = {
  title: 'ToolCards/ReadFileCard',
  component: ReadFileCard,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <ThreadProvider threadId={null}>
        <Story />
      </ThreadProvider>
    ),
  ],
} satisfies Meta<typeof ReadFileCard>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Reading a TypeScript file */
export const TypeScriptFile: Story = {
  name: 'TypeScript File',
  args: {
    parsed: { file_path: '/home/user/project/src/index.ts' },
  },
};

/** Reading a config file */
export const ConfigFile: Story = {
  name: 'Config File',
  args: {
    parsed: { file_path: '/home/user/project/tsconfig.json' },
  },
};

/** Reading a deeply nested file */
export const DeepPath: Story = {
  name: 'Deep Nested Path',
  args: {
    parsed: { file_path: '/home/user/project/packages/runtime/src/routes/threads.ts' },
  },
};

/** Without label */
export const HiddenLabel: Story = {
  name: 'Hidden Label',
  args: {
    parsed: { file_path: '/home/user/project/src/utils.ts' },
    hideLabel: true,
  },
};

/** Long paths must truncate without overlapping the collapse control or timestamp. */
export const CollapsedLongPath: Story = {
  args: {
    parsed: {
      file_path:
        '/home/user/project/packages/runtime/src/services/thread-service/very-long-file-name.ts',
    },
    output: 'export const value = 1;',
    displayTime: '12:34',
  },
  decorators: [
    (Story) => (
      <div style={{ width: 320 }}>
        <Story />
      </div>
    ),
  ],
  play: async ({ canvasElement }) => {
    const { expect, within } = await import('storybook/test');
    const canvas = within(canvasElement);
    const label = canvas.getByText('Read File');
    const path = canvas.getByText(/very-long-file-name.ts/);
    const timestamp = canvas.getByText('12:34');

    expect(path.getBoundingClientRect().left).toBeGreaterThan(label.getBoundingClientRect().right);
    expect(path.getBoundingClientRect().right).toBeLessThan(timestamp.getBoundingClientRect().left);
    expect(path.clientWidth).toBeGreaterThan(0);
    expect(path.scrollWidth).toBeGreaterThan(path.clientWidth);
  },
};
