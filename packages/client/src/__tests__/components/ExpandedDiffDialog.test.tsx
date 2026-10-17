import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { ExpandedDiffDialog, ExpandedDiffView } from '@/components/tool-cards/ExpandedDiffDialog';

import { renderWithProviders } from '../helpers/render';

const viewport = vi.hoisted(() => ({ mobile: false }));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => viewport.mobile }));

const diffProps = vi.hoisted(() => ({ current: null as Record<string, any> | null }));

vi.mock('@/components/VirtualDiff', () => ({
  VirtualDiff: (props: { 'data-testid'?: string; viewMode?: string }) => {
    diffProps.current = props;
    return (
      <div data-testid={props['data-testid'] ?? 'virtual-diff'} data-view-mode={props.viewMode} />
    );
  },
}));

vi.mock('@/components/thread/MessageContent', () => ({
  MessageContent: ({ content }: { content: string }) => (
    <article data-testid="rendered-markdown">{content}</article>
  ),
}));

const writeText = vi.fn();

describe('ExpandedDiffDialog markdown preview', () => {
  beforeEach(() => {
    viewport.mobile = false;
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

test('mobile diffs use a full-screen unified viewer', () => {
  viewport.mobile = true;
  renderWithProviders(
    <ExpandedDiffDialog
      open
      onOpenChange={vi.fn()}
      filePath="file.ts"
      oldValue="old"
      newValue="new"
    />,
  );
  expect(screen.getByRole('dialog')).toHaveClass('h-dvh', 'w-screen');
  expect(screen.getByTestId('expanded-diff-viewer')).toHaveAttribute('data-view-mode', 'unified');
  viewport.mobile = false;
});

test('dialog search shortcuts, toolbar toggles and review threads', () => {
  const onOpenChange = vi.fn();
  renderWithProviders(
    <ExpandedDiffDialog
      open
      onOpenChange={onOpenChange}
      filePath="src/a.ts"
      oldValue="a"
      newValue="b"
      baseLine={7}
      prReviewThreads={[
        { id: 't1', path: 'src/a.ts', comments: [] } as any,
        { id: 't2', path: 'src/a.ts', comments: [] } as any,
      ]}
    />,
  );
  expect(diffProps.current!.viewMode).toBe('three-pane');
  expect(diffProps.current!.unifiedDiff).toContain('@@ -7,1 +7,1 @@');

  fireEvent.keyDown(window, { key: 'f', metaKey: true });
  expect(screen.getByTestId('diff-search-bar')).toBeInTheDocument();
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(screen.queryByTestId('diff-search-bar')).not.toBeInTheDocument();
  expect(onOpenChange).not.toHaveBeenCalled();

  fireEvent.click(screen.getByTestId('diff-view-mode-unified'));
  expect(diffProps.current!.viewMode).toBe('unified');
  fireEvent.click(screen.getByTestId('diff-toggle-word-wrap'));
  expect(diffProps.current!.wordWrap).toBe(true);
  expect(screen.getByTestId('diff-review-threads')).toHaveTextContent('2 review threads');
});

describe('ExpandedDiffView behavior', () => {
  const rawDiff = [
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,3 +1,3 @@',
    ' keep',
    '-old one',
    '+new one',
    '-old two',
    '+new two',
  ].join('\n');

  const selectedArray = () => [...(diffProps.current!.selectedLines as Set<number>)].sort();

  test('line selection: toggle, hunk, drag and select/deselect signals', () => {
    const onSelectionStateChange = vi.fn();
    const props = {
      filePath: 'src/a.ts',
      oldValue: 'keep\nold one\nold two',
      newValue: 'keep\nnew one\nnew two',
      rawDiff,
      selectable: true,
      initialViewMode: 'unified' as const,
      onSelectionStateChange,
    };
    const { rerender } = renderWithProviders(<ExpandedDiffView {...props} />);

    const all = selectedArray();
    expect(all.length).toBe(4);
    expect(diffProps.current!.selectable).toBe(true);

    act(() => diffProps.current!.onLineToggle(all[0]));
    expect(selectedArray()).toEqual(all.slice(1));
    expect(onSelectionStateChange).toHaveBeenLastCalledWith('src/a.ts', 'partial');

    act(() => diffProps.current!.onLineToggle(all[0]));
    expect(selectedArray()).toEqual(all);
    expect(onSelectionStateChange).toHaveBeenLastCalledWith('src/a.ts', 'all');

    act(() => diffProps.current!.onHunkToggle(all));
    expect(selectedArray()).toEqual([]);
    expect(onSelectionStateChange).toHaveBeenLastCalledWith('src/a.ts', 'none');

    act(() => diffProps.current!.onHunkToggle(all.slice(0, 2)));
    expect(selectedArray()).toEqual(all.slice(0, 2));

    // Drag deselect over the first two, then extend over everything (relative to snapshot)
    act(() => diffProps.current!.onDragSelect(all[1], all[0], false));
    expect(selectedArray()).toEqual([]);
    act(() => diffProps.current!.onDragSelect(all[0], all[3], true));
    expect(selectedArray()).toEqual(all);
    fireEvent.mouseUp(window);
    act(() => diffProps.current!.onDragSelect(all[2], all[3], false));
    expect(selectedArray()).toEqual(all.slice(0, 2));

    rerender(<ExpandedDiffView {...props} deselectAllSignal={1} />);
    expect(selectedArray()).toEqual([]);
    rerender(<ExpandedDiffView {...props} deselectAllSignal={1} selectAllSignal={1} />);
    expect(selectedArray()).toEqual(all);
  });

  test('selection is disabled outside unified mode', () => {
    renderWithProviders(
      <ExpandedDiffView
        filePath="src/a.ts"
        oldValue="a"
        newValue="b"
        rawDiff={rawDiff}
        selectable
      />,
    );
    expect(diffProps.current!.viewMode).toBe('three-pane');
    expect(diffProps.current!.selectable).toBe(false);
    expect(diffProps.current!.selectedLines).toBeUndefined();
    expect(diffProps.current!.onLineToggle).toBeUndefined();
    fireEvent.click(screen.getByTestId('diff-view-view-mode-split'));
    expect(diffProps.current!.viewMode).toBe('split');
    expect(diffProps.current!.splitView).toBe(true);
  });

  test('one-sided diffs force unified mode and hide the view mode toggle', () => {
    renderWithProviders(<ExpandedDiffView filePath="src/new.ts" oldValue="" newValue="fresh" />);
    expect(screen.queryByTestId('diff-view-view-mode-group')).not.toBeInTheDocument();
    expect(diffProps.current!.viewMode).toBe('unified');
  });

  test('search toggles, keyboard shortcuts and match navigation', () => {
    const onClose = vi.fn();
    renderWithProviders(
      <ExpandedDiffView
        filePath="src/a.ts"
        oldValue="a"
        newValue="b"
        rawDiff={rawDiff}
        onClose={onClose}
      />,
    );

    fireEvent.keyDown(window, { key: 'f', ctrlKey: true });
    expect(screen.getByTestId('diff-view-search-bar')).toBeInTheDocument();

    fireEvent.change(screen.getByTestId('diff-view-search-input'), { target: { value: 'new' } });
    expect(diffProps.current!.searchQuery).toBe('new');
    act(() => diffProps.current!.onMatchCount(3));
    fireEvent.click(screen.getByTestId('diff-view-search-next'));
    expect(diffProps.current!.currentMatchIndex).toBe(1);
    fireEvent.click(screen.getByTestId('diff-view-search-prev'));
    fireEvent.click(screen.getByTestId('diff-view-search-prev'));
    expect(diffProps.current!.currentMatchIndex).toBe(2);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('diff-view-search-bar')).not.toBeInTheDocument();
    expect(diffProps.current!.searchQuery).toBeUndefined();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('diff-view-toggle-search'));
    expect(screen.getByTestId('diff-view-search-bar')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('diff-view-toggle-search'));
    expect(screen.queryByTestId('diff-view-search-bar')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('diff-view-toggle-word-wrap'));
    expect(diffProps.current!.wordWrap).toBe(true);
    fireEvent.click(screen.getByTestId('expanded-diff-close'));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  test('full file toggle loads and shows the full diff', async () => {
    const fullRaw = '@@ -1,2 +1,2 @@\n ctx\n-a\n+b';
    const onRequestFullDiff = vi
      .fn()
      .mockResolvedValue({ oldValue: 'ctx\na', newValue: 'ctx\nb', rawDiff: fullRaw });
    renderWithProviders(
      <ExpandedDiffView
        filePath="src/a.ts"
        oldValue="a"
        newValue="b"
        rawDiff={rawDiff}
        onRequestFullDiff={onRequestFullDiff}
      />,
    );
    expect(diffProps.current!.unifiedDiff).toBe(rawDiff);
    expect(diffProps.current!.codeFolding).toBe(true);

    fireEvent.click(screen.getByTestId('diff-view-toggle-full-file'));
    await waitFor(() => expect(diffProps.current!.unifiedDiff).toBe(fullRaw));
    expect(diffProps.current!.codeFolding).toBe(false);
    expect(diffProps.current!.showMinimap).toBe(true);

    fireEvent.click(screen.getByTestId('diff-view-toggle-full-file'));
    await waitFor(() => expect(diffProps.current!.unifiedDiff).toBe(rawDiff));
    expect(onRequestFullDiff).toHaveBeenCalledTimes(1);
  });

  test('renders PR review threads for the current file', () => {
    renderWithProviders(
      <ExpandedDiffView
        filePath="src/a.ts"
        oldValue="a"
        newValue="b"
        prReviewThreads={[
          { id: 't1', path: 'src/a.ts', comments: [] } as any,
          { id: 't2', path: 'src/other.ts', comments: [] } as any,
        ]}
      />,
    );
    expect(screen.getByTestId('diff-view-review-threads')).toHaveTextContent('1 review thread');
  });
});
