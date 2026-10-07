import type { Meta, StoryObj } from '@storybook/react-vite';

import '@/i18n/config';
import { ThreadProvider } from '@/stores/thread-context';

import { WriteFileCard } from './WriteFileCard';

const meta = {
  title: 'ToolCards/WriteFileCard',
  component: WriteFileCard,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <ThreadProvider threadId={null}>
        <Story />
      </ThreadProvider>
    ),
  ],
} satisfies Meta<typeof WriteFileCard>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Writing a new TypeScript file */
export const NewTypeScriptFile: Story = {
  name: 'New TypeScript File',
  args: {
    parsed: {
      file_path: '/home/user/project/src/utils/validation.ts',
      content: `import { Result, ok, err } from 'neverthrow';

export function validateEmail(email: string): Result<string, string> {
  const re = /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/;
  if (!re.test(email)) {
    return err('Invalid email format');
  }
  return ok(email.toLowerCase().trim());
}

export function validatePort(port: number): Result<number, string> {
  if (port < 1 || port > 65535) {
    return err('Port must be between 1 and 65535');
  }
  return ok(port);
}`,
    },
  },
};

/** Writing a JSON config file */
export const JsonConfig: Story = {
  name: 'JSON Config',
  args: {
    parsed: {
      file_path: '/home/user/project/tsconfig.json',
      content: `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "./dist"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}`,
    },
  },
};

/** Writing an empty file placeholder */
export const EmptyFile: Story = {
  name: 'Empty File',
  args: {
    parsed: {
      file_path: '/home/user/project/src/types.ts',
      content: '',
    },
  },
};

/** Writing a CSS file */
export const CssFile: Story = {
  name: 'CSS File',
  args: {
    parsed: {
      file_path: '/home/user/project/src/styles/globals.css',
      content: `@tailwind base;
@tailwind components;
@tailwind utilities;

@layer base {
  :root {
    --background: 0 0% 100%;
    --foreground: 240 10% 3.9%;
    --primary: 240 5.9% 10%;
    --primary-foreground: 0 0% 98%;
  }

  .dark {
    --background: 240 10% 3.9%;
    --foreground: 0 0% 98%;
    --primary: 0 0% 98%;
    --primary-foreground: 240 5.9% 10%;
  }
}`,
    },
  },
};

/** Without label */
export const HiddenLabel: Story = {
  name: 'Hidden Label',
  args: {
    parsed: {
      file_path: '/home/user/project/src/config.ts',
      content: 'export const API_URL = "http://localhost:3001";',
    },
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
    displayTime: '12:34',
  },
  decorators: [
    (Story) => (
      <div style={{ width: 320 }}>
        <Story />
      </div>
    ),
  ],
  play: async ({ canvasElement, userEvent }) => {
    const { expect, within } = await import('storybook/test');
    const canvas = within(canvasElement);
    const label = canvas.getByText('Write File');
    await userEvent.click(canvas.getByRole('button', { name: 'Write File' }));
    const path = canvas.getByText(/very-long-file-name.ts/);
    const timestamp = canvas.getByText('12:34');

    expect(path.getBoundingClientRect().left).toBeGreaterThan(label.getBoundingClientRect().right);
    expect(path.getBoundingClientRect().right).toBeLessThan(timestamp.getBoundingClientRect().left);
    expect(path.clientWidth).toBeGreaterThan(0);
    expect(path.scrollWidth).toBeGreaterThan(path.clientWidth);
  },
};
