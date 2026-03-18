import type { FileDiffSummary } from '@funny/shared';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import { FileTree } from './FileTree';

/* ── Mock data ── */

const mockFiles: FileDiffSummary[] = [
  {
    path: 'packages/client/src/components/ReviewPane.tsx',
    status: 'modified',
    staged: false,
    additions: 42,
    deletions: 18,
  },
  {
    path: 'packages/client/src/components/FileTree.tsx',
    status: 'added',
    staged: false,
    additions: 310,
    deletions: 0,
  },
  {
    path: 'packages/client/src/components/tool-cards/ExpandedDiffDialog.tsx',
    status: 'modified',
    staged: false,
    additions: 15,
    deletions: 120,
  },
  {
    path: 'packages/client/src/components/DiffStats.tsx',
    status: 'modified',
    staged: true,
    additions: 3,
    deletions: 1,
  },
  {
    path: 'packages/server/src/routes/projects.ts',
    status: 'modified',
    staged: false,
    additions: 22,
    deletions: 5,
  },
  {
    path: 'packages/server/src/services/project-repository.ts',
    status: 'modified',
    staged: false,
    additions: 8,
    deletions: 3,
  },
  {
    path: 'packages/shared/src/types.ts',
    status: 'modified',
    staged: false,
    additions: 6,
    deletions: 0,
  },
  {
    path: '.gitignore',
    status: 'modified',
    staged: false,
    additions: 1,
    deletions: 0,
  },
  {
    path: 'README.md',
    status: 'deleted',
    staged: false,
    additions: 0,
    deletions: 45,
  },
  {
    path: 'packages/client/src/hooks/use-ws.ts',
    status: 'renamed',
    staged: false,
    additions: 10,
    deletions: 2,
  },
];

const noop = () => {};

/* ── Meta ── */

const meta = {
  title: 'Components/FileTree',
  component: FileTree,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
} satisfies Meta<typeof FileTree>;

export default meta;
type Story = StoryObj<typeof meta>;

/* ── Stories ── */

/** Full file tree with checkboxes and all menu actions. */
export const Default: Story = {
  args: {
    files: mockFiles,
    onFileClick: noop,
    basePath: '/home/user/projects/funny',
  },
  render: () => {
    const [selected, setSelected] = useState<string | null>(
      'packages/client/src/components/ReviewPane.tsx',
    );
    const [checked, setChecked] = useState(new Set(mockFiles.map((f) => f.path)));

    return (
      <div className="w-80 rounded-md border border-border bg-sidebar">
        <FileTree
          files={mockFiles}
          selectedFile={selected}
          checkedFiles={checked}
          onFileClick={(path) => setSelected(path)}
          onToggleFile={(path) => {
            setChecked((prev) => {
              const next = new Set(prev);
              if (next.has(path)) next.delete(path);
              else next.add(path);
              return next;
            });
          }}
          onRevertFile={noop}
          onIgnore={noop}
          basePath="/home/user/projects/funny"
        />
      </div>
    );
  },
};

/** Without checkboxes (read-only navigation, like in ExpandedDiffDialog). */
export const WithoutCheckboxes: Story = {
  args: {
    files: mockFiles,
    onFileClick: noop,
  },
  render: () => {
    const [selected, setSelected] = useState<string | null>(
      'packages/client/src/components/FileTree.tsx',
    );

    return (
      <div className="w-80 rounded-md border border-border bg-sidebar">
        <FileTree
          files={mockFiles}
          selectedFile={selected}
          onFileClick={(path) => setSelected(path)}
          basePath="/home/user/projects/funny"
        />
      </div>
    );
  },
};

/** With text-sm font size (as used in ExpandedDiffDialog). */
export const LargerFont: Story = {
  name: 'Larger Font (text-sm)',
  args: {
    files: mockFiles,
    onFileClick: noop,
  },
  render: () => {
    const [selected, setSelected] = useState<string | null>(
      'packages/client/src/components/ReviewPane.tsx',
    );
    const [checked, setChecked] = useState(new Set(mockFiles.map((f) => f.path)));

    return (
      <div className="w-80 rounded-md border border-border bg-sidebar">
        <FileTree
          files={mockFiles}
          selectedFile={selected}
          checkedFiles={checked}
          fontSize="text-sm"
          onFileClick={(path) => setSelected(path)}
          onToggleFile={(path) => {
            setChecked((prev) => {
              const next = new Set(prev);
              if (next.has(path)) next.delete(path);
              else next.add(path);
              return next;
            });
          }}
          onRevertFile={noop}
          onIgnore={noop}
          basePath="/home/user/projects/funny"
        />
      </div>
    );
  },
};

/** Empty state — no files. */
export const Empty: Story = {
  args: {
    files: [],
    onFileClick: noop,
  },
  render: () => (
    <div className="w-80 rounded-md border border-border bg-sidebar p-3 text-xs text-muted-foreground">
      <FileTree files={[]} onFileClick={noop} />
      <p className="mt-2">No changes</p>
    </div>
  ),
};

/** Single file with no folders. */
export const SingleFile: Story = {
  args: {
    files: [{ path: 'index.ts', status: 'modified', staged: false, additions: 5, deletions: 2 }],
    onFileClick: noop,
  },
  render: () => {
    const files: FileDiffSummary[] = [
      { path: 'index.ts', status: 'modified', staged: false, additions: 5, deletions: 2 },
    ];
    const [selected, setSelected] = useState<string | null>('index.ts');

    return (
      <div className="w-80 rounded-md border border-border bg-sidebar">
        <FileTree files={files} selectedFile={selected} onFileClick={(path) => setSelected(path)} />
      </div>
    );
  },
};

/** Deep nesting with path compaction. */
export const DeepNesting: Story = {
  args: {
    files: mockFiles,
    onFileClick: noop,
  },
  render: () => {
    const files: FileDiffSummary[] = [
      {
        path: 'packages/client/src/components/ui/button.tsx',
        status: 'modified',
        staged: false,
        additions: 3,
        deletions: 1,
      },
      {
        path: 'packages/client/src/components/ui/input.tsx',
        status: 'modified',
        staged: false,
        additions: 7,
        deletions: 2,
      },
      {
        path: 'packages/client/src/components/ui/dialog.tsx',
        status: 'added',
        staged: false,
        additions: 120,
        deletions: 0,
      },
      {
        path: 'packages/server/src/routes/auth.ts',
        status: 'deleted',
        staged: false,
        additions: 0,
        deletions: 80,
      },
      {
        path: 'packages/server/src/routes/projects.ts',
        status: 'modified',
        staged: true,
        additions: 15,
        deletions: 5,
      },
      {
        path: 'packages/server/src/middleware/cors.ts',
        status: 'added',
        staged: false,
        additions: 25,
        deletions: 0,
      },
    ];
    const [selected, setSelected] = useState<string | null>(null);
    const [checked, setChecked] = useState(new Set(files.map((f) => f.path)));

    return (
      <div className="w-80 rounded-md border border-border bg-sidebar">
        <FileTree
          files={files}
          selectedFile={selected}
          checkedFiles={checked}
          onFileClick={(path) => setSelected(path)}
          onToggleFile={(path) => {
            setChecked((prev) => {
              const next = new Set(prev);
              if (next.has(path)) next.delete(path);
              else next.add(path);
              return next;
            });
          }}
          onRevertFile={noop}
          onIgnore={noop}
        />
      </div>
    );
  },
};
