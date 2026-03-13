import type { Meta, StoryObj } from '@storybook/react-vite';

import '@/i18n/config';
import { EditFileCard } from './EditFileCard';

const meta = {
  title: 'ToolCards/EditFileCard',
  component: EditFileCard,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
} satisfies Meta<typeof EditFileCard>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Simple single-line edit */
export const SingleLineEdit: Story = {
  name: 'Single Line Edit',
  args: {
    parsed: {
      file_path: '/home/user/project/src/config.ts',
      old_string: 'const PORT = 3000;',
      new_string: 'const PORT = process.env.PORT || 3001;',
    },
  },
};

/** Multi-line edit with added lines */
export const MultiLineEdit: Story = {
  name: 'Multi-Line Edit',
  args: {
    parsed: {
      file_path: '/home/user/project/src/routes/api.ts',
      old_string: `app.get('/health', (c) => {
  return c.json({ status: 'ok' });
});`,
      new_string: `app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    version: process.env.APP_VERSION || '0.0.0',
    uptime: process.uptime(),
  });
});`,
    },
  },
};

/** Import statement changes */
export const ImportEdit: Story = {
  name: 'Import Changes',
  args: {
    parsed: {
      file_path: '/home/user/project/src/index.ts',
      old_string: `import { Hono } from 'hono';
import { cors } from 'hono/cors';`,
      new_string: `import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { compress } from 'hono/compress';`,
    },
  },
};

/** No diff (same old and new) */
export const NoDiff: Story = {
  name: 'No Diff (Same Content)',
  args: {
    parsed: {
      file_path: '/home/user/project/src/utils.ts',
      old_string: 'const x = 1;',
      new_string: 'const x = 1;',
    },
  },
};

/** Without label */
export const HiddenLabel: Story = {
  name: 'Hidden Label',
  args: {
    parsed: {
      file_path: '/home/user/project/src/app.ts',
      old_string: 'debugStatement("old");',
      new_string: '// removed debug log',
    },
    hideLabel: true,
  },
};
