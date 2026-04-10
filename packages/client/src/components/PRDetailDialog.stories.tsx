import type { GitHubPR, PRCommit, PRFile } from '@funny/shared';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { okAsync } from 'neverthrow';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';

import { PRDetailDialog } from './PRDetailDialog';

// ── Sample diffs ────────────────────────────────────────────────────────────

const COMPONENT_PATCH = `@@ -1,15 +1,28 @@
-import { useState } from 'react';
+import { useState, useCallback } from 'react';
+
+import { cn } from '@/lib/utils';

 interface Props {
   title: string;
+  className?: string;
+  defaultOpen?: boolean;
 }

-export function Card({ title }: Props) {
-  const [open, setOpen] = useState(false);
+export function Card({ title, className, defaultOpen = false }: Props) {
+  const [open, setOpen] = useState(defaultOpen);
+
+  const handleToggle = useCallback(() => {
+    setOpen((prev) => !prev);
+  }, []);

   return (
-    <div className="card">
+    <div className={cn("card", className)}>
       <h2>{title}</h2>
-      <button onClick={() => setOpen(!open)}>Toggle</button>
-      {open && <p>Content goes here</p>}
+      <button onClick={handleToggle} data-testid="card-toggle">
+        {open ? 'Collapse' : 'Expand'}
+      </button>
+      {open && (
+        <div className="card-content">
+          <p>Content goes here</p>
+        </div>
+      )}
     </div>
   );
 }`;

const ROUTES_PATCH = `@@ -1,14 +1,28 @@
 import { Hono } from 'hono';
+import { zValidator } from '@hono/zod-validator';
+import { z } from 'zod';

 const app = new Hono();

+const userSchema = z.object({
+  name: z.string().min(1),
+  email: z.string().email(),
+});
+
 app.get('/api/users', async (c) => {
-  const users = await db.query('SELECT * FROM users');
-  return c.json(users);
+  const { limit, offset } = c.req.query();
+  const users = await db.query('SELECT * FROM users LIMIT ? OFFSET ?', [
+    Number(limit) || 50,
+    Number(offset) || 0,
+  ]);
+  return c.json({ data: users, total: users.length });
 });

-app.post('/api/users', async (c) => {
-  const body = await c.req.json();
+app.post('/api/users', zValidator('json', userSchema), async (c) => {
+  const body = c.req.valid('json');
   const user = await db.insert('users', body);
   return c.json(user, 201);
 });
+
+app.delete('/api/users/:id', async (c) => {
+  const id = c.req.param('id');
+  await db.delete('users', id);
+  return c.body(null, 204);
+});

 export default app;`;

const CONFIG_PATCH = `@@ -0,0 +1,12 @@
+export interface Config {
+  port: number;
+  host: string;
+  debug: boolean;
+  logLevel: 'trace' | 'debug' | 'info' | 'warn' | 'error';
+}
+
+export const defaultConfig: Config = {
+  port: 3000,
+  host: 'localhost',
+  debug: false,
+  logLevel: 'info',
+};`;

const DELETED_PATCH = `@@ -1,5 +0,0 @@
-export function noop() {}
-export function identity<T>(x: T): T { return x; }
-export function delay(ms: number) {
-  return new Promise((r) => setTimeout(r, ms));
-}`;

const HOOK_PATCH = `@@ -3,7 +3,9 @@
 export function useAuth() {
   const [user, setUser] = useState(null);

-  useEffect(() => { fetchUser().then(setUser); }, []);
+  useEffect(() => {
+    fetchUser().then(setUser).catch(console.error);
+  }, []);

   return user;
 }`;

// ── Mock data ───────────────────────────────────────────────────────────────

const MOCK_FILES: PRFile[] = [
  {
    sha: 'a1b2c3d',
    filename: 'src/components/Card.tsx',
    status: 'modified',
    additions: 20,
    deletions: 8,
    changes: 28,
    patch: COMPONENT_PATCH,
  },
  {
    sha: 'e4f5g6h',
    filename: 'src/server/routes.ts',
    status: 'modified',
    additions: 18,
    deletions: 5,
    changes: 23,
    patch: ROUTES_PATCH,
  },
  {
    sha: 'i7j8k9l',
    filename: 'src/config.ts',
    status: 'added',
    additions: 12,
    deletions: 0,
    changes: 12,
    patch: CONFIG_PATCH,
  },
  {
    sha: 'm0n1o2p',
    filename: 'src/old-utils.ts',
    status: 'removed',
    additions: 0,
    deletions: 5,
    changes: 5,
    patch: DELETED_PATCH,
  },
  {
    sha: 'q3r4s5t',
    filename: 'src/hooks/use-auth.ts',
    status: 'modified',
    additions: 3,
    deletions: 1,
    changes: 4,
    patch: HOOK_PATCH,
  },
];

const MOCK_COMMITS: PRCommit[] = [
  {
    sha: 'abc1234567890',
    message:
      'feat: add className and defaultOpen props to Card\n\nRefactored toggle logic with useCallback',
    author: { login: 'octocat', avatar_url: '' },
    date: '2026-04-08T10:30:00Z',
  },
  {
    sha: 'def4567890123',
    message: 'feat: add zod validation and delete endpoint to routes',
    author: { login: 'octocat', avatar_url: '' },
    date: '2026-04-08T11:15:00Z',
  },
  {
    sha: 'ghi7890123456',
    message: 'chore: add config module, remove old utils',
    author: { login: 'octocat', avatar_url: '' },
    date: '2026-04-08T12:00:00Z',
  },
  {
    sha: 'jkl0123456789',
    message: 'fix: catch errors in useAuth hook',
    author: { login: 'contributor42', avatar_url: '' },
    date: '2026-04-09T09:00:00Z',
  },
];

const MOCK_PR: GitHubPR = {
  number: 42,
  title: 'feat: refactor Card component, add validation to routes, and clean up utils',
  state: 'open',
  html_url: 'https://github.com/acme/app/pull/42',
  user: { login: 'octocat', avatar_url: 'https://github.com/octocat.png' },
  created_at: '2026-04-08T10:00:00Z',
  updated_at: '2026-04-09T09:00:00Z',
  head: { ref: 'feat/card-refactor', label: 'octocat:feat/card-refactor' },
  base: { ref: 'main', label: 'acme:main' },
  draft: false,
  labels: [
    { name: 'enhancement', color: '84b6eb' },
    { name: 'review-needed', color: 'fbca04' },
  ],
  merged_at: null,
};

const MOCK_PR_MERGED: GitHubPR = {
  ...MOCK_PR,
  number: 38,
  title: 'fix: resolve race condition in auth middleware',
  state: 'closed',
  html_url: 'https://github.com/acme/app/pull/38',
  head: { ref: 'fix/auth-race', label: 'octocat:fix/auth-race' },
  merged_at: '2026-04-07T14:00:00Z',
  labels: [{ name: 'bug', color: 'd73a4a' }],
};

const MOCK_PR_DRAFT: GitHubPR = {
  ...MOCK_PR,
  number: 45,
  title: 'wip: experimental caching layer for API responses',
  draft: true,
  head: { ref: 'feat/api-cache', label: 'octocat:feat/api-cache' },
  labels: [],
};

// ── Helpers ─────────────────────────────────────────────────────────────────

function mockApi(files: PRFile[] = MOCK_FILES, commits: PRCommit[] = MOCK_COMMITS) {
  api.githubPRFiles = () => okAsync({ files });
  api.githubPRCommits = () => okAsync({ commits });
  api.githubPRRevertFile = () => okAsync({ ok: true, action: 'reverted' as const });
  api.githubPRFileContent = (_pid, _prNum, filePath) =>
    okAsync({
      baseContent: `// base version of ${filePath}\nexport {};\n`,
      headContent: `// head version of ${filePath}\nexport default {};\n`,
    });
}

/** Wrapper that manages its own open state so dialogs don't all open at once in autodocs. */
function PRDetailDialogTrigger({
  pr,
  projectId,
  label,
  setupMocks,
}: {
  pr: GitHubPR;
  projectId: string;
  label?: string;
  setupMocks: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="outline"
        data-testid="pr-detail-dialog-trigger"
        onClick={() => {
          setupMocks();
          setOpen(true);
        }}
      >
        {label ?? `Open PR #${pr.number}`}
      </Button>
      <PRDetailDialog open={open} onOpenChange={setOpen} projectId={projectId} pr={pr} />
    </>
  );
}

// ── Storybook meta ──────────────────────────────────────────────────────────

const meta = {
  title: 'Components/PRDetailDialog',
  component: PRDetailDialog,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof PRDetailDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

// ── Stories ──────────────────────────────────────────────────────────────────

/** Default open PR with multiple files and commits. */
export const Default: Story = {
  render: () => (
    <PRDetailDialogTrigger pr={MOCK_PR} projectId="proj-1" setupMocks={() => mockApi()} />
  ),
};

/** Merged PR. */
export const Merged: Story = {
  render: () => (
    <PRDetailDialogTrigger
      pr={MOCK_PR_MERGED}
      projectId="proj-1"
      label="Open Merged PR #38"
      setupMocks={() => mockApi()}
    />
  ),
};

/** Draft PR. */
export const Draft: Story = {
  render: () => (
    <PRDetailDialogTrigger
      pr={MOCK_PR_DRAFT}
      projectId="proj-1"
      label="Open Draft PR #45"
      setupMocks={() => mockApi()}
    />
  ),
};

/** Single file changed. */
export const SingleFile: Story = {
  render: () => (
    <PRDetailDialogTrigger
      pr={MOCK_PR}
      projectId="proj-1"
      label="Open PR (single file)"
      setupMocks={() => mockApi([MOCK_FILES[0]], [MOCK_COMMITS[0]])}
    />
  ),
};

/** Loading state — API never resolves. */
export const Loading: Story = {
  render: () => (
    <PRDetailDialogTrigger
      pr={MOCK_PR}
      projectId="proj-1"
      label="Open PR (loading)"
      setupMocks={() => {
        api.githubPRFiles = () => new Promise(() => {}) as any;
        api.githubPRCommits = () => new Promise(() => {}) as any;
      }}
    />
  ),
};

/** Error state. */
export const Error: Story = {
  render: () => (
    <PRDetailDialogTrigger
      pr={MOCK_PR}
      projectId="proj-1"
      label="Open PR (error)"
      setupMocks={() => {
        api.githubPRFiles = () => okAsync({ files: [] });
        api.githubPRCommits = () => okAsync({ commits: [] });
      }}
    />
  ),
};

/** No files changed. */
export const NoFilesChanged: Story = {
  render: () => (
    <PRDetailDialogTrigger
      pr={MOCK_PR}
      projectId="proj-1"
      label="Open PR (no files)"
      setupMocks={() => mockApi([], MOCK_COMMITS)}
    />
  ),
};

/** Many files (stress test for file tree). */
export const ManyFiles: Story = {
  render: () => {
    const manyFiles: PRFile[] = Array.from({ length: 40 }, (_, i) => ({
      sha: `sha-${i}`,
      filename: `src/${['components', 'hooks', 'lib', 'utils', 'stores', 'routes'][i % 6]}/${['Button', 'Input', 'Dialog', 'Select', 'Card', 'Table', 'Form', 'Modal'][i % 8]}${Math.floor(i / 8) || ''}.tsx`,
      status: (['modified', 'added', 'removed', 'modified', 'modified'] as const)[i % 5],
      additions: Math.floor(Math.random() * 50) + 1,
      deletions: Math.floor(Math.random() * 30),
      changes: Math.floor(Math.random() * 80) + 1,
      patch: COMPONENT_PATCH,
    }));
    return (
      <PRDetailDialogTrigger
        pr={MOCK_PR}
        projectId="proj-1"
        label="Open PR (40 files)"
        setupMocks={() => mockApi(manyFiles, MOCK_COMMITS)}
      />
    );
  },
};
