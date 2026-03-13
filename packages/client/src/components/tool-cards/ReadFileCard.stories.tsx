import type { Meta, StoryObj } from '@storybook/react-vite';

import '@/i18n/config';
import { ReadFileCard } from './ReadFileCard';

const meta = {
  title: 'ToolCards/ReadFileCard',
  component: ReadFileCard,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
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
