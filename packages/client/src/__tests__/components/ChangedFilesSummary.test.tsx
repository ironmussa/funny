import type { FileDiffSummary } from '@funny/shared';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, test, expect, vi, beforeEach } from 'vitest';

import { ChangedFilesSummary } from '@/components/thread/ChangedFilesSummary';

import { renderWithProviders } from '../helpers/render';

// ── Mocks ───────────────────────────────────────────────────────

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallbackOrOpts?: string | Record<string, any>) => {
      if (typeof fallbackOrOpts === 'string') return fallbackOrOpts;
      const opts = fallbackOrOpts ?? {};
      const tmpl = (opts.defaultValue as string) ?? key;
      return tmpl.replace('{{count}}', String(opts.count ?? ''));
    },
    i18n: { language: 'en' },
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

const revertFiles = vi.fn();
const getFileDiff = vi.fn();
vi.mock('@/lib/api', async () => {
  const { okAsync } = await import('neverthrow');
  return {
    api: {
      revertFiles: (...args: unknown[]) => {
        revertFiles(...args);
        return okAsync({ ok: true });
      },
      getFileDiff: (...args: unknown[]) => {
        getFileDiff(...args);
        return okAsync({ diff: '' });
      },
    },
  };
});

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

function file(path: string, additions: number, deletions: number): FileDiffSummary {
  return { path, status: 'modified', staged: false, additions, deletions };
}

describe('ChangedFilesSummary', () => {
  beforeEach(() => {
    revertFiles.mockClear();
    getFileDiff.mockClear();
  });

  test('renders nothing when there are no changed files', () => {
    const { container } = renderWithProviders(<ChangedFilesSummary threadId="t1" files={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  test('summarizes file count and aggregate +/- stats', () => {
    const files = [file('docs/launch-readout.md', 6, 2), file('docs/release-checklist.md', 4, 0)];
    renderWithProviders(<ChangedFilesSummary threadId="t1" files={files} />);

    expect(screen.getByText('2 files changed')).toBeInTheDocument();
    // Aggregate totals: +10 / -2 (the +10 only appears in the header total)
    expect(screen.getByText('+10')).toBeInTheDocument();
    // -2 shows both in the header total and on the launch-readout row
    expect(screen.getAllByText('-2')).toHaveLength(2);
    // Per-file rows
    expect(screen.getByTestId('changed-files-row-docs/launch-readout.md')).toBeInTheDocument();
    expect(screen.getByTestId('changed-files-row-docs/release-checklist.md')).toBeInTheDocument();
  });

  test('Undo reverts this session’s files, then notifies the parent', async () => {
    const onReverted = vi.fn();
    const files = [file('a.ts', 1, 1), file('b.ts', 2, 0)];
    renderWithProviders(
      <ChangedFilesSummary threadId="t1" files={files} onReverted={onReverted} />,
    );

    fireEvent.click(screen.getByTestId('changed-files-undo'));

    await waitFor(() => expect(revertFiles).toHaveBeenCalledWith('t1', ['a.ts', 'b.ts']));
    await waitFor(() => expect(onReverted).toHaveBeenCalled());
  });

  test('disables Undo while running to avoid racing live edits', () => {
    renderWithProviders(<ChangedFilesSummary threadId="t1" files={[file('a.ts', 1, 1)]} running />);

    expect(screen.getByTestId('changed-files-summary')).toBeInTheDocument();
    expect(screen.getByTestId('changed-files-undo')).toBeDisabled();
  });

  test('clicking a file name opens the diff popup and loads its diff', async () => {
    const files = [file('docs/launch-readout.md', 6, 2)];
    renderWithProviders(<ChangedFilesSummary threadId="t1" files={files} />);

    fireEvent.click(screen.getByTestId('changed-files-open-docs/launch-readout.md'));

    // Opening the file pulls its diff via the shared getFileDiff endpoint.
    await waitFor(() =>
      expect(getFileDiff).toHaveBeenCalledWith('t1', 'docs/launch-readout.md', false),
    );
    // The thread's shared diff dialog mounts (its toolbar is always present).
    await waitFor(() => expect(screen.getByTestId('diff-toggle-word-wrap')).toBeInTheDocument());
  });

  test('backfills +/- stats from tool-call diffs when the snapshot is stat-less', () => {
    // A session that commits before finishing snapshots against a clean working
    // tree, so its rows arrive without additions/deletions. The card must derive
    // them from the session's tool-call fallback diffs instead of showing bare
    // file names.
    const statless: FileDiffSummary[] = [
      { path: 'src/main.ts', status: 'modified', staged: false },
    ];
    const fallbackDiffs = new Map([
      [
        'src/main.ts',
        '--- a/src/main.ts\n+++ b/src/main.ts\n@@ -1,1 +1,2 @@\n-old\n+new one\n+new two',
      ],
    ]);
    renderWithProviders(
      <ChangedFilesSummary threadId="t1" files={statless} fallbackDiffs={fallbackDiffs} />,
    );

    // Derived stats show both in the header total and on the file row.
    expect(screen.getAllByText('+2')).toHaveLength(2);
    expect(screen.getAllByText('-1')).toHaveLength(2);
  });

  test('uses the session fallback diff when the live diff is empty', async () => {
    const files = [file('index.ts', 6, 2)];
    const fallbackDiffs = new Map([
      ['index.ts', '--- a/index.ts\n+++ b/index.ts\n@@ -1,1 +1,1 @@\n-old value\n+new value'],
    ]);
    renderWithProviders(
      <ChangedFilesSummary threadId="t1" files={files} fallbackDiffs={fallbackDiffs} />,
    );

    fireEvent.click(screen.getByTestId('changed-files-open-index.ts'));

    await waitFor(() => expect(screen.getByTestId('expanded-diff-viewer')).toBeInTheDocument());
    expect(screen.queryByText('No diff available')).not.toBeInTheDocument();
  });
});
