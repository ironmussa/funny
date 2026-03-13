import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';

import { MonacoEditorDialog } from './MonacoEditorDialog';

const meta = {
  title: 'Components/MonacoEditorDialog',
  component: MonacoEditorDialog,
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
  args: {
    open: true,
    onOpenChange: fn(),
  },
} satisfies Meta<typeof MonacoEditorDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

const SAMPLE_TS = `import { Hono } from 'hono';
import { cors } from 'hono/cors';

const app = new Hono();

app.use('*', cors());

app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    version: process.env.APP_VERSION || '0.0.0',
    uptime: process.uptime(),
  });
});

export default app;
`;

const SAMPLE_JSON = `{
  "name": "funny",
  "version": "1.0.0",
  "dependencies": {
    "hono": "^4.0.0",
    "drizzle-orm": "^0.30.0"
  },
  "scripts": {
    "dev": "bun run --watch src/index.ts",
    "build": "bun build src/index.ts --outdir dist"
  }
}
`;

const SAMPLE_MD = `# Project README

## Getting Started

Install dependencies:

\`\`\`bash
bun install
\`\`\`

Run in development:

\`\`\`bash
bun run dev
\`\`\`

## Architecture

The project uses a **monorepo** structure with three packages:

- \`packages/client\` — React SPA
- \`packages/server\` — Hono API
- \`packages/shared\` — TypeScript types

| Package | Port | Description |
|---------|------|-------------|
| client  | 5173 | Vite dev server |
| server  | 3001 | API server |
`;

const SAMPLE_PY = `from dataclasses import dataclass
from typing import Optional


@dataclass
class User:
    name: str
    email: str
    age: Optional[int] = None

    def greet(self) -> str:
        return f"Hello, {self.name}!"


def process_users(users: list[User]) -> dict[str, int]:
    """Count users by age group."""
    groups: dict[str, int] = {}
    for user in users:
        key = "unknown" if user.age is None else f"{user.age // 10 * 10}s"
        groups[key] = groups.get(key, 0) + 1
    return groups
`;

export const TypeScript: Story = {
  args: {
    filePath: '/home/user/project/src/index.ts',
    initialContent: SAMPLE_TS,
  },
};

export const JSON: Story = {
  args: {
    filePath: '/home/user/project/package.json',
    initialContent: SAMPLE_JSON,
  },
};

export const Markdown: Story = {
  args: {
    filePath: '/home/user/project/README.md',
    initialContent: SAMPLE_MD,
  },
};

export const Python: Story = {
  args: {
    filePath: '/home/user/project/src/main.py',
    initialContent: SAMPLE_PY,
  },
};

export const EmptyFile: Story = {
  args: {
    filePath: '/home/user/project/src/new-file.ts',
    initialContent: '',
  },
};
