import type { Meta, StoryObj } from '@storybook/react-vite';
import { okAsync } from 'neverthrow';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { useProjectStore } from '@/stores/project-store';
import { useThreadStore } from '@/stores/thread-store';

import { FileSearchDialog } from './FileSearchDialog';

/* ------------------------------------------------------------------ */
/*  Mock data                                                         */
/* ------------------------------------------------------------------ */

const MOCK_FILES = [
  'src/index.ts',
  'src/components/Sidebar.tsx',
  'src/components/ThreadView.tsx',
  'src/hooks/use-ws.ts',
  'src/stores/app-store.ts',
  'src/lib/utils.ts',
  'package.json',
  'tsconfig.json',
  'vite.config.ts',
  'README.md',
];

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function setupStores() {
  useProjectStore.setState({
    selectedProjectId: 'proj-1',
    projects: [
      {
        id: 'proj-1',
        name: 'my-project',
        path: '/home/user/project',
        userId: 'u1',
        createdAt: '2026-01-01T00:00:00Z',
      },
    ] as any,
  });
  useThreadStore.setState({ activeThread: null } as any);
}

/* ------------------------------------------------------------------ */
/*  Trigger wrapper                                                   */
/* ------------------------------------------------------------------ */

function FileSearchTrigger({ label, setupMocks }: { label: string; setupMocks: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="outline"
        data-testid="file-search-trigger"
        onClick={() => {
          setupMocks();
          setOpen(true);
        }}
      >
        {label}
      </Button>
      <FileSearchDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  Storybook meta                                                    */
/* ------------------------------------------------------------------ */

const meta: Meta = {
  title: 'Dialogs/FileSearchDialog',
  component: FileSearchDialog,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj;

/* ------------------------------------------------------------------ */
/*  Stories                                                            */
/* ------------------------------------------------------------------ */

function rankedResponse(files: string[], total = files.length) {
  return {
    matches: files.map((path) => ({ path, indices: [] })),
    total,
    truncated: total > files.length,
    basePath: '/home/user/project',
  };
}

/** Default — file list loaded. */
export const Default: Story = {
  render: () => (
    <FileSearchTrigger
      label="Search files"
      setupMocks={() => {
        setupStores();
        api.searchFiles = () => okAsync(rankedResponse(MOCK_FILES));
      }}
    />
  ),
};

/** Truncated results — shows "refine your search" hint. */
export const Truncated: Story = {
  render: () => {
    const manyFiles = Array.from({ length: 500 }, (_, i) => `src/components/Component${i}.tsx`);
    const visibleFiles = manyFiles.slice(0, 200);
    return (
      <FileSearchTrigger
        label="Search (truncated)"
        setupMocks={() => {
          setupStores();
          api.searchFiles = () => okAsync(rankedResponse(visibleFiles, manyFiles.length));
        }}
      />
    );
  },
};

/** Empty results. */
export const NoResults: Story = {
  render: () => (
    <FileSearchTrigger
      label="Search (no results)"
      setupMocks={() => {
        setupStores();
        api.searchFiles = () => okAsync(rankedResponse([]));
      }}
    />
  ),
};

/** Loading state — index fetch never resolves. */
export const Loading: Story = {
  render: () => (
    <FileSearchTrigger
      label="Search (loading)"
      setupMocks={() => {
        setupStores();
        api.searchFiles = () => new Promise(() => {}) as never;
      }}
    />
  ),
};
