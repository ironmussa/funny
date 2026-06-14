import type { FileDiffSummary } from '@funny/shared';
import { fireEvent, render, screen } from '@testing-library/react';
import { FileCode } from 'lucide-react';
import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
    i18n: { language: 'en' },
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

// Stub the heavy diff renderer (Monaco/VirtualDiff). We only assert the mobile
// chrome + navigation + that read-only/unified props are threaded through.
vi.mock('@/components/tool-cards/ExpandedDiffDialog', () => ({
  ExpandedDiffView: (props: {
    filePath: string;
    initialViewMode?: string;
    selectable?: boolean;
    onStagePatch?: unknown;
    onClose?: unknown;
  }) => (
    <div
      data-testid="stub-expanded-diff"
      data-file={props.filePath}
      data-initial-view-mode={props.initialViewMode ?? ''}
      data-selectable={String(!!props.selectable)}
      data-has-onstagepatch={String(!!props.onStagePatch)}
      data-has-onclose={String(!!props.onClose)}
    />
  ),
}));

// Controllable viewport switch for the presenter test.
let mockIsMobile = true;
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => mockIsMobile }));

// Desktop modal stub so the presenter test doesn't pull in Radix Dialog + FileTree.
vi.mock('@/components/review-pane/DiffViewerModal', () => ({
  DiffViewerModal: (p: { expandedFile: string | null }) =>
    p.expandedFile ? <div data-testid="expanded-diff-overlay" /> : null,
}));

import { ExpandedDiffPresenter } from '@/components/review-pane/ExpandedDiffPresenter';
import { MobileDiffView } from '@/components/review-pane/MobileDiffView';

function file(path: string): FileDiffSummary {
  return { path, status: 'modified', staged: false };
}

const FILES = [file('a.ts'), file('b.ts'), file('c.ts')];

function mobileProps(overrides: Partial<Parameters<typeof MobileDiffView>[0]> = {}) {
  const expandedFile = overrides.expandedFile ?? 'a.ts';
  return {
    expandedFile,
    expandedSummary: FILES.find((f) => f.path === expandedFile),
    expandedDiffContent: 'diff body',
    ExpandedIcon: FileCode,
    onClose: vi.fn(),
    onFileSelect: vi.fn(),
    filteredDiffs: FILES,
    summaries: FILES,
    loadingDiff: null,
    diffCache: new Map<string, string>(),
    prThreads: undefined,
    requestFullDiff: vi.fn(),
    handleResolveConflict: vi.fn(),
    ...overrides,
  } as Parameters<typeof MobileDiffView>[0];
}

afterEach(() => {
  mockIsMobile = true;
});

describe('MobileDiffView — full-screen read-only diff', () => {
  test('renders the full-screen overlay (not the desktop dialog) for the open file', () => {
    render(<MobileDiffView {...mobileProps()} />);
    expect(screen.getByTestId('mobile-diff-overlay')).toBeInTheDocument();
    expect(screen.queryByTestId('expanded-diff-overlay')).not.toBeInTheDocument();
  });

  test('renders nothing when no file is open', () => {
    const { container } = render(<MobileDiffView {...mobileProps({ expandedFile: null })} />);
    expect(container).toBeEmptyDOMElement();
  });

  test('is read-only and forces unified view', () => {
    render(<MobileDiffView {...mobileProps()} />);
    const stub = screen.getByTestId('stub-expanded-diff');
    expect(stub).toHaveAttribute('data-selectable', 'false');
    expect(stub).toHaveAttribute('data-has-onstagepatch', 'false');
    // The nav-bar back button is the single close affordance — ExpandedDiffView
    // does not get its own onClose (so no duplicate X).
    expect(stub).toHaveAttribute('data-has-onclose', 'false');
    expect(stub).toHaveAttribute('data-initial-view-mode', 'unified');
  });

  test('back button invokes onClose', () => {
    const onClose = vi.fn();
    render(<MobileDiffView {...mobileProps({ onClose })} />);
    fireEvent.click(screen.getByTestId('mobile-diff-back'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('MobileDiffView — prev/next navigation', () => {
  test('prev disabled on the first file, next enabled, position 1/3', () => {
    render(<MobileDiffView {...mobileProps({ expandedFile: 'a.ts' })} />);
    expect(screen.getByTestId('mobile-diff-position')).toHaveTextContent('1/3');
    expect(screen.getByTestId('mobile-diff-prev')).toBeDisabled();
    expect(screen.getByTestId('mobile-diff-next')).not.toBeDisabled();
  });

  test('next disabled on the last file, prev enabled, position 3/3', () => {
    render(<MobileDiffView {...mobileProps({ expandedFile: 'c.ts' })} />);
    expect(screen.getByTestId('mobile-diff-position')).toHaveTextContent('3/3');
    expect(screen.getByTestId('mobile-diff-next')).toBeDisabled();
    expect(screen.getByTestId('mobile-diff-prev')).not.toBeDisabled();
  });

  test('tapping next selects the following file', () => {
    const onFileSelect = vi.fn();
    render(<MobileDiffView {...mobileProps({ expandedFile: 'b.ts', onFileSelect })} />);
    fireEvent.click(screen.getByTestId('mobile-diff-next'));
    expect(onFileSelect).toHaveBeenCalledWith('c.ts');
  });

  test('tapping prev selects the preceding file', () => {
    const onFileSelect = vi.fn();
    render(<MobileDiffView {...mobileProps({ expandedFile: 'b.ts', onFileSelect })} />);
    fireEvent.click(screen.getByTestId('mobile-diff-prev'));
    expect(onFileSelect).toHaveBeenCalledWith('a.ts');
  });

  test('single file disables both arrows', () => {
    render(
      <MobileDiffView
        {...mobileProps({
          expandedFile: 'only.ts',
          filteredDiffs: [file('only.ts')],
          summaries: [file('only.ts')],
        })}
      />,
    );
    expect(screen.getByTestId('mobile-diff-prev')).toBeDisabled();
    expect(screen.getByTestId('mobile-diff-next')).toBeDisabled();
  });

  test('open file excluded by a filter hides the position and disables both arrows', () => {
    render(<MobileDiffView {...mobileProps({ expandedFile: 'z.ts' })} />);
    expect(screen.queryByTestId('mobile-diff-position')).not.toBeInTheDocument();
    expect(screen.getByTestId('mobile-diff-prev')).toBeDisabled();
    expect(screen.getByTestId('mobile-diff-next')).toBeDisabled();
  });
});

describe('ExpandedDiffPresenter — viewport switch', () => {
  // The presenter forwards a superset of props; cast keeps the test focused on
  // the switch rather than reconstructing every DiffViewerModal prop.
  const presenterProps = () =>
    mobileProps() as unknown as Parameters<typeof ExpandedDiffPresenter>[0];

  test('mobile viewport renders the full-screen overlay, not the desktop dialog', () => {
    mockIsMobile = true;
    render(<ExpandedDiffPresenter {...presenterProps()} />);
    expect(screen.getByTestId('mobile-diff-overlay')).toBeInTheDocument();
    expect(screen.queryByTestId('expanded-diff-overlay')).not.toBeInTheDocument();
  });

  test('desktop viewport renders the centered dialog, not the mobile overlay', () => {
    mockIsMobile = false;
    render(<ExpandedDiffPresenter {...presenterProps()} />);
    expect(screen.getByTestId('expanded-diff-overlay')).toBeInTheDocument();
    expect(screen.queryByTestId('mobile-diff-overlay')).not.toBeInTheDocument();
  });
});
