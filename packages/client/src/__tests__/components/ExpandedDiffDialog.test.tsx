import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { ExpandedDiffDialog, ExpandedDiffView } from '@/components/tool-cards/ExpandedDiffDialog';

import { renderWithProviders } from '../helpers/render';

vi.mock('@/components/VirtualDiff', () => ({
  VirtualDiff: ({ 'data-testid': testId }: { 'data-testid'?: string }) => (
    <div data-testid={testId ?? 'virtual-diff'} />
  ),
}));

vi.mock('@/components/thread/MessageContent', () => ({
  MessageContent: ({ content }: { content: string }) => (
    <article data-testid="rendered-markdown">{content}</article>
  ),
}));

const writeText = vi.fn();

describe('ExpandedDiffDialog markdown preview', () => {
  beforeEach(() => {
    writeText.mockClear();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
  });

  test('copies the full text and toggles a Markdown file between diff and rendered preview', async () => {
    const fullDiff = {
      oldValue: '# Previous title\n',
      newValue: '# Current title\n\nFull document body.\n',
      rawDiff: '@@ -1 +1,3 @@\n-# Previous title\n+# Current title\n+\n+Full document body.',
    };
    let resolveFullDiff!: (value: typeof fullDiff) => void;
    const onRequestFullDiff = vi.fn().mockImplementation(
      () =>
        new Promise<typeof fullDiff>((resolve) => {
          resolveFullDiff = resolve;
        }),
    );

    renderWithProviders(
      <ExpandedDiffDialog
        open
        onOpenChange={vi.fn()}
        filePath="docs/report.md"
        oldValue="# Previous title"
        newValue="# Current title"
        onRequestFullDiff={onRequestFullDiff}
      />,
    );

    expect(screen.getByTestId('expanded-diff-viewer')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('diff-copy-full-file'));

    await waitFor(() => expect(onRequestFullDiff).toHaveBeenCalledWith('docs/report.md'));
    expect(screen.getByTestId('expanded-diff-viewer')).toBeInTheDocument();

    await act(async () => resolveFullDiff(fullDiff));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith('# Current title\n\nFull document body.\n'),
    );

    fireEvent.click(screen.getByTestId('diff-toggle-markdown-preview'));

    expect(await screen.findByTestId('diff-markdown-preview')).toBeInTheDocument();
    expect(screen.getByTestId('rendered-markdown')).toHaveTextContent(
      '# Current title Full document body.',
    );
    expect(screen.queryByTestId('expanded-diff-viewer')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('diff-toggle-markdown-preview'));
    expect(screen.getByTestId('expanded-diff-viewer')).toBeInTheDocument();
    expect(onRequestFullDiff).toHaveBeenCalledTimes(1);
  });

  test('does not offer Markdown preview for non-Markdown files', () => {
    renderWithProviders(
      <ExpandedDiffDialog
        open
        onOpenChange={vi.fn()}
        filePath="src/index.ts"
        oldValue="export const value = 1;"
        newValue="export const value = 2;"
      />,
    );

    expect(screen.queryByTestId('diff-toggle-markdown-preview')).not.toBeInTheDocument();
  });
});

describe('ExpandedDiffView markdown preview', () => {
  test('offers rendered Markdown preview in the Changed-files diff viewer', async () => {
    const onRequestFullDiff = vi.fn().mockResolvedValue({
      oldValue: '# Previous title\n',
      newValue: '# Current title\n\nFull document body.\n',
      rawDiff: '@@ -1 +1,3 @@\n-# Previous title\n+# Current title\n+\n+Full document body.',
    });

    renderWithProviders(
      <ExpandedDiffView
        filePath="docs/report.md"
        oldValue="# Previous title"
        newValue="# Current title"
        rawDiff="@@ -1 +1 @@\n-# Previous title\n+# Current title"
        onRequestFullDiff={onRequestFullDiff}
      />,
    );

    expect(screen.getByTestId('diff-view-toggle-markdown-preview')).toBeInTheDocument();
    expect(screen.getByTestId('expanded-diff-viewer')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('diff-view-toggle-markdown-preview'));

    expect(await screen.findByTestId('diff-view-markdown-preview')).toBeInTheDocument();
    expect(onRequestFullDiff).toHaveBeenCalledWith('docs/report.md');
    expect(screen.getByTestId('rendered-markdown')).toHaveTextContent(
      '# Current title Full document body.',
    );
    expect(screen.queryByTestId('expanded-diff-viewer')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('diff-view-toggle-markdown-preview'));
    expect(screen.getByTestId('expanded-diff-viewer')).toBeInTheDocument();
    expect(onRequestFullDiff).toHaveBeenCalledTimes(1);
  });

  test('does not offer Markdown preview for a deleted file', () => {
    renderWithProviders(
      <ExpandedDiffView
        filePath="docs/report.md"
        oldValue="# Removed title"
        newValue=""
        files={[{ path: 'docs/report.md', status: 'deleted', staged: false }]}
      />,
    );

    expect(screen.queryByTestId('diff-view-toggle-markdown-preview')).not.toBeInTheDocument();
  });

  test('does not offer a partial Markdown preview without a full-file provider', () => {
    renderWithProviders(
      <ExpandedDiffView
        filePath="docs/report.markdown"
        oldValue="# Previous title"
        newValue="# Current title"
        rawDiff="@@ -1 +1 @@\n-# Previous title\n+# Current title"
      />,
    );

    expect(screen.queryByTestId('diff-view-toggle-markdown-preview')).not.toBeInTheDocument();
  });
});
