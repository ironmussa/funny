import { afterEach, expect, mock, test } from 'bun:test';

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { CommitDetailDialog } from '@/components/commit-history/CommitDetailDialog';
import { TooltipProvider } from '@/components/ui/tooltip';

const ok = <T,>(value: T) => ({ isOk: () => true, isErr: () => false, value });

mock.module('@/lib/api', () => ({
  api: {
    getCommitFiles: async () =>
      ok({ files: [{ path: 'src/a.ts', status: 'modified', additions: 1, deletions: 0 }] }),
    getCommitBody: async () => ok({ body: '' }),
    getCommitFileDiff: async () => ok({ diff: '' }),
  },
}));

afterEach(cleanup);

function commit(hash: string, body: string) {
  return {
    hash,
    shortHash: hash.slice(0, 7),
    author: 'Ada',
    authorEmail: 'ada@example.com',
    authoredAt: 0,
    message: `Commit ${hash}`,
    body,
  };
}

function renderDialog(hash: string, body: string) {
  return (
    <TooltipProvider>
      <CommitDetailDialog
        selectedCommit={commit(hash, body)}
        selectedHash={hash}
        effectiveThreadId="thread-1"
        projectModeId={null}
        githubAvatarBySha={new Map()}
        onClose={() => {}}
        onAfterAction={() => {}}
      />
    </TooltipProvider>
  );
}

test('a new commit shows its own body and clears the file filter', async () => {
  const { rerender } = render(renderDialog('aaaaaaaaaa', 'Body of A'));
  expect(screen.getByText('Body of A')).toBeInTheDocument();

  const filter = await screen.findByPlaceholderText('Filter files…');
  fireEvent.change(filter, { target: { value: 'src/' } });
  expect(filter).toHaveValue('src/');

  act(() => {
    rerender(renderDialog('bbbbbbbbbb', 'Body of B'));
  });

  expect(screen.getByText('Body of B')).toBeInTheDocument();
  expect(screen.queryByText('Body of A')).toBeNull();
  await waitFor(() => expect(screen.getByPlaceholderText('Filter files…')).toHaveValue(''));
});
