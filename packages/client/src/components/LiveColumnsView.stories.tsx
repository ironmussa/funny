import type { Thread, Project, Message, ToolCall } from '@funny/shared';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { okAsync } from 'neverthrow';
import { useEffect } from 'react';
import { MemoryRouter } from 'react-router-dom';

import '@/i18n/config';
import { TooltipProvider } from '@/components/ui/tooltip';
import { api } from '@/lib/api';
import { useAuthStore } from '@/stores/auth-store';
import { useProjectStore } from '@/stores/project-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useThreadStore, type ThreadWithMessages } from '@/stores/thread-store';

import { LiveColumnsView } from './LiveColumnsView';

// ── Helpers ──────────────────────────────────────────────────────

let counter = 0;
function uid() {
  return `id-${++counter}`;
}

function makeThread(overrides: Partial<Thread> = {}): Thread {
  const id = overrides.id ?? uid();
  return {
    id,
    projectId: 'proj-1',
    userId: 'user-1',
    title: 'Implement feature',
    mode: 'worktree',
    status: 'running',
    stage: 'in_progress',
    provider: 'claude',
    permissionMode: 'autoEdit',
    model: 'sonnet',
    branch: 'feat/work',
    baseBranch: 'master',
    cost: 0.08,
    runtime: 'local',
    source: 'web',
    purpose: 'implement',
    createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    ...overrides,
  };
}

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'proj-1',
    name: 'funny',
    path: '/home/user/funny',
    userId: 'user-1',
    createdAt: new Date().toISOString(),
    ...overrides,
  } as Project;
}

function seedStores({
  projects = [makeProject()],
  threadsByProject = {} as Record<string, Thread[]>,
}: {
  projects?: Project[];
  threadsByProject?: Record<string, Thread[]>;
} = {}) {
  useAuthStore.setState({
    user: { id: 'user-1', username: 'admin', displayName: 'Admin User', role: 'admin' },
    isAuthenticated: true,
    isLoading: false,
    activeOrgId: null,
    activeOrgName: null,
    activeOrgSlug: null,
  });

  useProjectStore.setState({ projects });

  useThreadStore.setState({
    threadsByProject,
    loadThreadsForProject: (() => Promise.resolve()) as any,
  });

  useSettingsStore.setState({ toolPermissions: {} });
}

// ── Meta ─────────────────────────────────────────────────────────

const meta = {
  title: 'Components/LiveColumnsView',
  component: LiveColumnsView,
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
  decorators: [
    (Story) => {
      counter = 0;
      seedStores();
      return (
        <MemoryRouter>
          <TooltipProvider>
            <div className="h-[700px] w-full bg-background">
              <Story />
            </div>
          </TooltipProvider>
        </MemoryRouter>
      );
    },
  ],
} satisfies Meta<typeof LiveColumnsView>;

export default meta;
type Story = StoryObj<typeof meta>;

// ── Stories ──────────────────────────────────────────────────────

/** Empty state: no active threads */
export const EmptyState: Story = {
  name: 'Empty State',
};

/** With active running threads (columns will show loading spinners since API isn't available) */
export const WithActiveThreads: Story = {
  name: 'With Active Threads',
  decorators: [
    (Story) => {
      counter = 0;
      const threads = [
        makeThread({
          id: 'run-1',
          title: 'Add dark mode support',
          status: 'running',
          branch: 'feat/dark-mode',
        }),
        makeThread({
          id: 'run-2',
          title: 'Fix WebSocket reconnection',
          status: 'running',
          branch: 'fix/ws-reconnect',
        }),
        makeThread({
          id: 'run-3',
          title: 'Implement file upload',
          status: 'waiting',
          branch: 'feat/file-upload',
        }),
        makeThread({
          id: 'done-1',
          title: 'Update dependencies',
          status: 'completed',
          branch: 'chore/deps',
          completedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
        }),
      ];
      seedStores({
        threadsByProject: { 'proj-1': threads },
      });
      return <Story />;
    },
  ],
};

/** Multi-project with many agents */
export const MultiProjectGrid: Story = {
  name: 'Multi-Project Grid',
  decorators: [
    (Story) => {
      counter = 0;
      const projects = [
        makeProject({ id: 'proj-1', name: 'funny', color: '#3b82f6' }),
        makeProject({ id: 'proj-2', name: 'api-server', color: '#ef4444' }),
        makeProject({ id: 'proj-3', name: 'design-system', color: '#a855f7' }),
      ];
      const threadsByProject = {
        'proj-1': [
          makeThread({
            id: 'a-1',
            projectId: 'proj-1',
            title: 'Add auth module',
            status: 'running',
            branch: 'feat/auth',
          }),
          makeThread({
            id: 'a-2',
            projectId: 'proj-1',
            title: 'Fix sidebar',
            status: 'running',
            branch: 'fix/sidebar',
          }),
        ],
        'proj-2': [
          makeThread({
            id: 'b-1',
            projectId: 'proj-2',
            title: 'Rate limiting',
            status: 'running',
            branch: 'feat/rate-limit',
          }),
        ],
        'proj-3': [
          makeThread({
            id: 'c-1',
            projectId: 'proj-3',
            title: 'New button variants',
            status: 'completed',
            branch: 'feat/buttons',
            completedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
          }),
        ],
      };
      seedStores({ projects, threadsByProject });
      return <Story />;
    },
  ],
};

/** Single thread running */
export const SingleThread: Story = {
  name: 'Single Thread',
  decorators: [
    (Story) => {
      counter = 0;
      seedStores({
        threadsByProject: {
          'proj-1': [
            makeThread({
              id: 'solo-1',
              title: 'Refactor database layer',
              status: 'running',
              branch: 'refactor/db',
            }),
          ],
        },
      });
      return <Story />;
    },
  ],
};

/** Many threads filling a large grid */
export const LargeGrid: Story = {
  name: 'Large Grid (many threads)',
  decorators: [
    (Story) => {
      counter = 0;
      const threads: Thread[] = [];
      for (let i = 0; i < 9; i++) {
        threads.push(
          makeThread({
            id: `grid-${i}`,
            title: `Agent task #${i + 1}: ${['Auth refactor', 'Dark mode', 'File upload', 'Search index', 'Rate limiting', 'WebSocket fix', 'DB migration', 'API docs', 'Test coverage'][i]}`,
            status: i < 5 ? 'running' : 'completed',
            branch: `feat/task-${i}`,
            completedAt: i >= 5 ? new Date(Date.now() - i * 10 * 60_000).toISOString() : undefined,
          }),
        );
      }
      seedStores({
        threadsByProject: { 'proj-1': threads },
      });
      return <Story />;
    },
  ],
};

// ── Helpers for rich content stories ────────────────────────────

function makeMessage(
  overrides: Partial<Message> & { toolCalls?: ToolCall[] },
): Message & { toolCalls?: ToolCall[] } {
  const id = overrides.id ?? uid();
  return {
    id,
    threadId: 'thread-1',
    role: 'assistant',
    content: '',
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function makeToolCall(overrides: Partial<ToolCall> = {}): ToolCall {
  const id = overrides.id ?? uid();
  return {
    id,
    messageId: 'msg-1',
    name: 'Read',
    input: JSON.stringify({ file_path: '/src/index.ts' }),
    ...overrides,
  };
}

function makeThreadWithMessages(
  thread: Thread,
  messages: (Message & { toolCalls?: ToolCall[] })[],
): ThreadWithMessages {
  return {
    ...thread,
    messages,
    hasMore: false,
  } as ThreadWithMessages;
}

/**
 * Installs a mock for `api.getThread` so ThreadColumn renders
 * inline content instead of hitting the network.
 */
function mockGetThread(threadsById: Record<string, ThreadWithMessages>) {
  const original = api.getThread;
  api.getThread = ((id: string) => {
    const thread = threadsById[id];
    if (thread) return okAsync(thread);
    return okAsync({ id, messages: [] } as any);
  }) as typeof api.getThread;
  return () => {
    api.getThread = original;
  };
}

/** Columns with visible messages, tool calls, and markdown content */
export const WithContent: Story = {
  name: 'With Content',
  decorators: [
    (Story) => {
      counter = 0;

      const threadA = makeThread({
        id: 'content-1',
        title: 'Add dark mode support',
        status: 'running',
        branch: 'feat/dark-mode',
      });

      const threadB = makeThread({
        id: 'content-2',
        title: 'Fix authentication bug',
        status: 'completed',
        branch: 'fix/auth-bug',
        completedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
      });

      const threadAMessages: (Message & { toolCalls?: ToolCall[] })[] = [
        makeMessage({
          id: 'ua-1',
          threadId: 'content-1',
          role: 'user',
          content: 'Add dark mode toggle to the settings page. Use CSS variables for theming.',
          timestamp: new Date(Date.now() - 4 * 60_000).toISOString(),
        }),
        makeMessage({
          id: 'aa-1',
          threadId: 'content-1',
          role: 'assistant',
          content:
            "I'll add dark mode support. Let me start by reading the current settings component and the CSS setup.",
          timestamp: new Date(Date.now() - 3.5 * 60_000).toISOString(),
          toolCalls: [
            makeToolCall({
              id: 'tc-a1',
              messageId: 'aa-1',
              name: 'Read',
              input: JSON.stringify({ file_path: '/src/components/Settings.tsx' }),
              output:
                'export function Settings() {\n  return (\n    <div className="settings-page">\n      <h1>Settings</h1>\n      <section>...</section>\n    </div>\n  );\n}',
            }),
            makeToolCall({
              id: 'tc-a2',
              messageId: 'aa-1',
              name: 'Read',
              input: JSON.stringify({ file_path: '/src/globals.css' }),
              output:
                ':root {\n  --background: #ffffff;\n  --foreground: #0a0a0a;\n  --primary: #3b82f6;\n}',
            }),
          ],
        }),
        makeMessage({
          id: 'aa-2',
          threadId: 'content-1',
          role: 'assistant',
          content:
            "I can see the CSS variable setup. Now I'll add the dark theme variables and a toggle component.",
          timestamp: new Date(Date.now() - 3 * 60_000).toISOString(),
          toolCalls: [
            makeToolCall({
              id: 'tc-a3',
              messageId: 'aa-2',
              name: 'Edit',
              input: JSON.stringify({
                file_path: '/src/globals.css',
                old_string: ':root {',
                new_string:
                  ':root {\n  /* Light theme */\n\n.dark {\n  --background: #0a0a0a;\n  --foreground: #fafafa;\n  --primary: #60a5fa;\n}',
              }),
              output: 'File edited successfully.',
            }),
            makeToolCall({
              id: 'tc-a4',
              messageId: 'aa-2',
              name: 'Write',
              input: JSON.stringify({
                file_path: '/src/components/ThemeToggle.tsx',
                content:
                  'export function ThemeToggle() {\n  const [dark, setDark] = useState(false);\n  return <Switch checked={dark} onChange={setDark} />;\n}',
              }),
              output: 'File written successfully.',
            }),
          ],
        }),
        makeMessage({
          id: 'aa-3',
          threadId: 'content-1',
          role: 'assistant',
          content:
            "The dark mode toggle is in place. I've added:\n\n- CSS variables for `.dark` class\n- A `ThemeToggle` component using a switch\n- Integration with the Settings page\n\nThe toggle persists the preference to `localStorage`.",
          timestamp: new Date(Date.now() - 2 * 60_000).toISOString(),
        }),
      ];

      const threadBMessages: (Message & { toolCalls?: ToolCall[] })[] = [
        makeMessage({
          id: 'ub-1',
          threadId: 'content-2',
          role: 'user',
          content: 'The login form throws a 401 even with correct credentials. Debug and fix it.',
          timestamp: new Date(Date.now() - 10 * 60_000).toISOString(),
        }),
        makeMessage({
          id: 'ab-1',
          threadId: 'content-2',
          role: 'assistant',
          content: 'Let me investigate the authentication flow to find the root cause.',
          timestamp: new Date(Date.now() - 9 * 60_000).toISOString(),
          toolCalls: [
            makeToolCall({
              id: 'tc-b1',
              messageId: 'ab-1',
              name: 'Bash',
              input: JSON.stringify({ command: 'grep -rn "401" src/api/auth/' }),
              output:
                'src/api/auth/login.ts:42:    return res.status(401).json({ error: "Invalid credentials" });\nsrc/api/auth/login.ts:58:    return res.status(401).json({ error: "Session expired" });',
            }),
            makeToolCall({
              id: 'tc-b2',
              messageId: 'ab-1',
              name: 'Read',
              input: JSON.stringify({ file_path: '/src/api/auth/login.ts' }),
              output:
                'export async function login(req, res) {\n  const { username, password } = req.body;\n  const user = await db.findUser(username);\n  if (!user || !bcrypt.compare(password, user.passwordHash)) {\n    return res.status(401).json({ error: "Invalid credentials" });\n  }\n  // BUG: compareSync should be used, not compare (returns Promise)\n  const token = jwt.sign({ userId: user.id }, SECRET);\n  return res.json({ token });\n}',
            }),
          ],
        }),
        makeMessage({
          id: 'ab-2',
          threadId: 'content-2',
          role: 'assistant',
          content:
            "Found the bug! `bcrypt.compare()` returns a Promise, but the code uses it as a boolean. This means the condition `!bcrypt.compare(...)` is always `false` (truthy Promise object, negated), so authentication *appears* to pass but the session isn't set up correctly.\n\n**Fix:** Use `await bcrypt.compare()` or `bcrypt.compareSync()`.",
          timestamp: new Date(Date.now() - 8 * 60_000).toISOString(),
          toolCalls: [
            makeToolCall({
              id: 'tc-b3',
              messageId: 'ab-2',
              name: 'Edit',
              input: JSON.stringify({
                file_path: '/src/api/auth/login.ts',
                old_string: '!bcrypt.compare(password, user.passwordHash)',
                new_string: '!(await bcrypt.compare(password, user.passwordHash))',
              }),
              output: 'File edited successfully.',
            }),
          ],
        }),
        makeMessage({
          id: 'ab-3',
          threadId: 'content-2',
          role: 'assistant',
          content:
            'Fixed the authentication bug. The `bcrypt.compare` call now properly awaits the Promise result. Login should work correctly now.',
          timestamp: new Date(Date.now() - 7 * 60_000).toISOString(),
        }),
      ];

      const threadsById: Record<string, ThreadWithMessages> = {
        'content-1': makeThreadWithMessages(threadA, threadAMessages),
        'content-2': makeThreadWithMessages(threadB, threadBMessages),
      };

      const cleanup = mockGetThread(threadsById);

      seedStores({
        threadsByProject: {
          'proj-1': [threadA, threadB],
        },
      });

      return (
        <>
          <Story />
          {/* cleanup on unmount */}
          <CleanupEffect cleanup={cleanup} />
        </>
      );
    },
  ],
};

/** Helper to run cleanup on unmount */
function CleanupEffect({ cleanup }: { cleanup: () => void }) {
  useEffect(() => cleanup, [cleanup]);
  return null;
}
