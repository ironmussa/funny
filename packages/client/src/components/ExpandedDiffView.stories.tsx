import type { FileDiffSummary } from '@funny/shared';
import type { Meta, StoryObj } from '@storybook/react-vite';

import { ExpandedDiffView } from './tool-cards/ExpandedDiffDialog';

/* ── Sample content ── */

const OLD_COMPONENT = `import { useState } from 'react';

interface Props {
  title: string;
}

export function Card({ title }: Props) {
  const [open, setOpen] = useState(false);

  return (
    <div className="card">
      <h2>{title}</h2>
      <button onClick={() => setOpen(!open)}>Toggle</button>
      {open && <p>Content goes here</p>}
    </div>
  );
}`;

const NEW_COMPONENT = `import { useState, useCallback } from 'react';

import { cn } from '@/lib/utils';

interface Props {
  title: string;
  className?: string;
  defaultOpen?: boolean;
}

export function Card({ title, className, defaultOpen = false }: Props) {
  const [open, setOpen] = useState(defaultOpen);

  const handleToggle = useCallback(() => {
    setOpen((prev) => !prev);
  }, []);

  return (
    <div className={cn("card", className)}>
      <h2>{title}</h2>
      <button onClick={handleToggle} data-testid="card-toggle">
        {open ? 'Collapse' : 'Expand'}
      </button>
      {open && (
        <div className="card-content">
          <p>Content goes here</p>
        </div>
      )}
    </div>
  );
}`;

const OLD_SIMPLE = `function greet(name) {
  return "Hello, " + name;
}`;

const NEW_SIMPLE = `function greet(name: string) {
  return \`Hello, \${name}!\`;
}`;

const OLD_SERVER = `import { Hono } from 'hono';

const app = new Hono();

app.get('/api/users', async (c) => {
  const users = await db.query('SELECT * FROM users');
  return c.json(users);
});

app.post('/api/users', async (c) => {
  const body = await c.req.json();
  const user = await db.insert('users', body);
  return c.json(user, 201);
});

export default app;`;

const NEW_SERVER = `import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';

const app = new Hono();

const userSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
});

app.get('/api/users', async (c) => {
  const { limit, offset } = c.req.query();
  const users = await db.query('SELECT * FROM users LIMIT ? OFFSET ?', [
    Number(limit) || 50,
    Number(offset) || 0,
  ]);
  return c.json({ data: users, total: users.length });
});

app.post('/api/users', zValidator('json', userSchema), async (c) => {
  const body = c.req.valid('json');
  const user = await db.insert('users', body);
  return c.json(user, 201);
});

app.delete('/api/users/:id', async (c) => {
  const id = c.req.param('id');
  await db.delete('users', id);
  return c.body(null, 204);
});

export default app;`;

const NEW_FILE_CONTENT = `export interface Config {
  port: number;
  host: string;
  debug: boolean;
  logLevel: 'trace' | 'debug' | 'info' | 'warn' | 'error';
}

export const defaultConfig: Config = {
  port: 3000,
  host: 'localhost',
  debug: false,
  logLevel: 'info',
};`;

/* ── Helper ── */

function computeUnifiedDiff(oldValue: string, newValue: string): string {
  const oldLines = oldValue.split('\n');
  const newLines = newValue.split('\n');
  const lines: string[] = ['--- a/file', '+++ b/file'];

  let prefixLen = 0;
  while (
    prefixLen < oldLines.length &&
    prefixLen < newLines.length &&
    oldLines[prefixLen] === newLines[prefixLen]
  )
    prefixLen++;

  let suffixLen = 0;
  while (
    suffixLen < oldLines.length - prefixLen &&
    suffixLen < newLines.length - prefixLen &&
    oldLines[oldLines.length - 1 - suffixLen] === newLines[newLines.length - 1 - suffixLen]
  )
    suffixLen++;

  const oldChanged = oldLines.slice(prefixLen, oldLines.length - suffixLen);
  const newChanged = newLines.slice(prefixLen, newLines.length - suffixLen);
  const ctxBefore = Math.min(prefixLen, 3);
  const ctxAfter = Math.min(suffixLen, 3);
  const hunkOldStart = prefixLen - ctxBefore + 1;
  const hunkOldLen = ctxBefore + oldChanged.length + ctxAfter;
  const hunkNewLen = ctxBefore + newChanged.length + ctxAfter;

  lines.push(`@@ -${hunkOldStart},${hunkOldLen} +${hunkOldStart},${hunkNewLen} @@`);
  for (let i = prefixLen - ctxBefore; i < prefixLen; i++) lines.push(` ${oldLines[i]}`);
  for (const l of oldChanged) lines.push(`-${l}`);
  for (const l of newChanged) lines.push(`+${l}`);
  for (let i = oldLines.length - suffixLen; i < oldLines.length - suffixLen + ctxAfter; i++)
    lines.push(` ${oldLines[i]}`);

  return lines.join('\n');
}

/* ── Mock files for multi-file stories ── */

const mockFiles: FileDiffSummary[] = [
  {
    path: 'src/components/Card.tsx',
    status: 'modified',
    staged: false,
    additions: 20,
    deletions: 8,
  },
  { path: 'src/server/routes.ts', status: 'modified', staged: false, additions: 18, deletions: 5 },
  { path: 'src/config.ts', status: 'added', staged: false, additions: 14, deletions: 0 },
  { path: 'src/old-utils.ts', status: 'deleted', staged: false, additions: 0, deletions: 30 },
  { path: 'src/hooks/use-auth.ts', status: 'modified', staged: true, additions: 3, deletions: 1 },
];

const mockDiffCache = new Map<string, string>([
  ['src/components/Card.tsx', computeUnifiedDiff(OLD_COMPONENT, NEW_COMPONENT)],
  ['src/server/routes.ts', computeUnifiedDiff(OLD_SERVER, NEW_SERVER)],
  ['src/config.ts', computeUnifiedDiff('', NEW_FILE_CONTENT)],
  ['src/old-utils.ts', computeUnifiedDiff('export const noop = () => {};', '')],
  ['src/hooks/use-auth.ts', computeUnifiedDiff(OLD_SIMPLE, NEW_SIMPLE)],
]);

/* ── Storybook meta ── */

const meta = {
  title: 'Components/ExpandedDiffView',
  component: ExpandedDiffView,
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
  args: {
    onClose: () => {},
  },
  decorators: [
    (Story) => (
      <div className="h-screen">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ExpandedDiffView>;

export default meta;
type Story = StoryObj<typeof meta>;

/* ── Stories ── */

export const Default: Story = {
  name: 'Default (Three-pane)',
  args: {
    filePath: 'src/components/Card.tsx',
    oldValue: OLD_COMPONENT,
    newValue: NEW_COMPONENT,
    rawDiff: computeUnifiedDiff(OLD_COMPONENT, NEW_COMPONENT),
  },
};

export const SingleFile: Story = {
  name: 'Single File',
  args: {
    filePath: 'src/server/routes.ts',
    oldValue: OLD_SERVER,
    newValue: NEW_SERVER,
    rawDiff: computeUnifiedDiff(OLD_SERVER, NEW_SERVER),
  },
};

export const WithFileTree: Story = {
  name: 'With File Tree Sidebar',
  args: {
    filePath: 'src/components/Card.tsx',
    oldValue: OLD_COMPONENT,
    newValue: NEW_COMPONENT,
    rawDiff: computeUnifiedDiff(OLD_COMPONENT, NEW_COMPONENT),
    files: mockFiles,
    diffCache: mockDiffCache,
    onFileSelect: () => {},
  },
};

export const NewFile: Story = {
  name: 'New File (Added)',
  args: {
    filePath: 'src/config.ts',
    oldValue: '',
    newValue: NEW_FILE_CONTENT,
    rawDiff: computeUnifiedDiff('', NEW_FILE_CONTENT),
    files: [{ path: 'src/config.ts', status: 'added', staged: false, additions: 14, deletions: 0 }],
  },
};

export const DeletedFile: Story = {
  name: 'Deleted File',
  args: {
    filePath: 'src/old-utils.ts',
    oldValue: 'export const noop = () => {};',
    newValue: '',
    rawDiff: computeUnifiedDiff('export const noop = () => {};', ''),
    files: [
      { path: 'src/old-utils.ts', status: 'deleted', staged: false, additions: 0, deletions: 1 },
    ],
  },
};

export const Loading: Story = {
  name: 'Loading State',
  args: {
    filePath: 'src/components/Card.tsx',
    oldValue: '',
    newValue: '',
    loading: true,
  },
};

export const SmallEdit: Story = {
  name: 'Small Edit',
  args: {
    filePath: 'src/utils/greet.ts',
    oldValue: OLD_SIMPLE,
    newValue: NEW_SIMPLE,
    rawDiff: computeUnifiedDiff(OLD_SIMPLE, NEW_SIMPLE),
  },
};
