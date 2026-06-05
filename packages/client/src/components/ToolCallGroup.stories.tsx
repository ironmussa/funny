import type { Meta, StoryObj } from '@storybook/react-vite';

import '@/i18n/config';
import { TooltipProvider } from '@/components/ui/tooltip';

import { ToolCallGroup } from './ToolCallGroup';

const meta = {
  title: 'Thread/ToolCallGroup',
  component: ToolCallGroup,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <TooltipProvider>
        <div className="max-w-3xl min-w-0">
          <Story />
        </div>
      </TooltipProvider>
    ),
  ],
} satisfies Meta<typeof ToolCallGroup>;

export default meta;
type Story = StoryObj<typeof meta>;

// ── Stories ──────────────────────────────────────────────────────

/** Multiple Read calls grouped together. */
export const ReadGroup: Story = {
  name: 'Read ×3',
  args: {
    name: 'Read',
    calls: [
      {
        id: 'tc-1',
        name: 'Read',
        input: { file_path: '/home/user/projects/funny/src/components/Sidebar.tsx' },
        output:
          'import React from "react";\n\nexport function Sidebar() {\n  return <div>Sidebar</div>;\n}',
      },
      {
        id: 'tc-2',
        name: 'Read',
        input: { file_path: '/home/user/projects/funny/src/stores/app-store.ts' },
        output:
          'import { create } from "zustand";\n\nexport const useAppStore = create(() => ({}));',
      },
      {
        id: 'tc-3',
        name: 'Read',
        input: { file_path: '/home/user/projects/funny/src/lib/utils.ts' },
        output:
          'import { clsx } from "clsx";\nimport { twMerge } from "tailwind-merge";\n\nexport function cn(...inputs) {\n  return twMerge(clsx(inputs));\n}',
      },
    ],
  },
};

/** Multiple Edit calls grouped together. */
export const EditGroup: Story = {
  name: 'Edit ×2',
  args: {
    name: 'Edit',
    calls: [
      {
        id: 'tc-1',
        name: 'Edit',
        input: {
          file_path: '/home/user/projects/funny/src/components/Sidebar.tsx',
          old_string: 'return <div>Sidebar</div>;',
          new_string:
            'return (\n    <aside className="w-64 border-r">\n      <nav>Sidebar</nav>\n    </aside>\n  );',
        },
        output: 'File edited successfully.',
      },
      {
        id: 'tc-2',
        name: 'Edit',
        input: {
          file_path: '/home/user/projects/funny/src/stores/app-store.ts',
          old_string: 'export const useAppStore = create(() => ({}));',
          new_string:
            'interface AppState {\n  sidebarOpen: boolean;\n  toggleSidebar: () => void;\n}\n\nexport const useAppStore = create<AppState>((set) => ({\n  sidebarOpen: true,\n  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),\n}));',
        },
        output: 'File edited successfully.',
      },
    ],
  },
};

/** Multiple Bash calls grouped together. */
export const BashGroup: Story = {
  name: 'Bash ×3',
  args: {
    name: 'Bash',
    calls: [
      {
        id: 'tc-1',
        name: 'Bash',
        input: { command: 'git status' },
        output:
          'On branch feat/sidebar\nChanges not staged for commit:\n  modified:   src/components/Sidebar.tsx\n  modified:   src/stores/app-store.ts',
      },
      {
        id: 'tc-2',
        name: 'Bash',
        input: { command: 'bun test src/components/Sidebar.test.tsx' },
        output:
          'bun test v1.0.0\n\n✓ Sidebar > renders navigation items (12ms)\n✓ Sidebar > toggles open/close (8ms)\n\n 2 pass\n 0 fail\n\n Ran 2 tests in 0.05s',
      },
      {
        id: 'tc-3',
        name: 'Bash',
        input: { command: 'wc -l src/components/Sidebar.tsx' },
        output: '42 src/components/Sidebar.tsx',
      },
    ],
  },
};

/** Single call in a group (edge case — count badge shows ×1). */
export const SingleCall: Story = {
  name: 'Single Call (×1)',
  args: {
    name: 'Read',
    calls: [
      {
        id: 'tc-1',
        name: 'Read',
        input: { file_path: '/home/user/projects/funny/package.json' },
        output: '{\n  "name": "funny",\n  "version": "0.1.0"\n}',
      },
    ],
  },
};

/** Many calls grouped together. */
export const ManyCalls: Story = {
  name: 'Many Calls (×8)',
  args: {
    name: 'Read',
    calls: Array.from({ length: 8 }, (_, i) => ({
      id: `tc-${i}`,
      name: 'Read',
      input: { file_path: `/home/user/projects/funny/src/file-${i + 1}.ts` },
      output: `// Content of file-${i + 1}.ts\nexport const value${i + 1} = ${i + 1};`,
    })),
  },
};

/** TodoWrite calls grouped together. */
export const TodoGroup: Story = {
  name: 'TodoWrite ×2',
  args: {
    name: 'TodoWrite',
    calls: [
      {
        id: 'tc-1',
        name: 'TodoWrite',
        input: {
          todos: [
            { id: '1', content: 'Extract UserMessageCard component', status: 'completed' },
            { id: '2', content: 'Add Storybook stories', status: 'in_progress' },
            { id: '3', content: 'Update ThreadView to use new component', status: 'pending' },
          ],
        },
      },
      {
        id: 'tc-2',
        name: 'TodoWrite',
        input: {
          todos: [
            { id: '1', content: 'Extract UserMessageCard component', status: 'completed' },
            { id: '2', content: 'Add Storybook stories', status: 'completed' },
            { id: '3', content: 'Update ThreadView to use new component', status: 'in_progress' },
          ],
        },
      },
    ],
  },
};

/** Multiple groups stacked — simulates a realistic agent work sequence. */
export const MultipleGroups: Story = {
  name: 'Realistic Sequence (multiple groups)',
  args: {
    name: 'Read',
    calls: [],
  },
  render: () => (
    <div className="space-y-1">
      <ToolCallGroup
        name="Read"
        calls={[
          {
            id: 'r1',
            name: 'Read',
            input: { file_path: '/home/user/projects/funny/src/components/Sidebar.tsx' },
            output: 'import React from "react";\n\nexport function Sidebar() { ... }',
          },
          {
            id: 'r2',
            name: 'Read',
            input: { file_path: '/home/user/projects/funny/src/stores/app-store.ts' },
            output: 'import { create } from "zustand";\n\nexport const useAppStore = create(...);',
          },
          {
            id: 'r3',
            name: 'Read',
            input: { file_path: '/home/user/projects/funny/src/lib/utils.ts' },
            output: 'export function cn(...inputs) { ... }',
          },
        ]}
      />
      <ToolCallGroup
        name="Edit"
        calls={[
          {
            id: 'e1',
            name: 'Edit',
            input: {
              file_path: '/home/user/projects/funny/src/components/Sidebar.tsx',
              old_string: 'return <div>Sidebar</div>;',
              new_string: 'return <aside className="w-64"><nav>Sidebar</nav></aside>;',
            },
            output: 'File edited successfully.',
          },
          {
            id: 'e2',
            name: 'Edit',
            input: {
              file_path: '/home/user/projects/funny/src/stores/app-store.ts',
              old_string: 'create(() => ({}))',
              new_string: 'create<AppState>((set) => ({ sidebarOpen: true }))',
            },
            output: 'File edited successfully.',
          },
        ]}
      />
      <ToolCallGroup
        name="Bash"
        calls={[
          {
            id: 'b1',
            name: 'Bash',
            input: { command: 'bun test' },
            output: '✓ 12 tests passed\n 0 failed\n Ran in 1.2s',
          },
          {
            id: 'b2',
            name: 'Bash',
            input: { command: 'bun run build' },
            output: '✓ 5662 modules transformed.\n✓ built in 3.4s',
          },
        ]}
      />
    </div>
  ),
};
