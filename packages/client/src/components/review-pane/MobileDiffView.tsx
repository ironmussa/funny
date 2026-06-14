import type { FileDiffSummary, PRReviewThread } from '@funny/shared';
import { ArrowLeft, ChevronLeft, ChevronRight } from 'lucide-react';
import type { ComponentType } from 'react';
import { useTranslation } from 'react-i18next';

import { ExpandedDiffView } from '@/components/tool-cards/ExpandedDiffDialog';
import { Button } from '@/components/ui/button';
import { parseDiffOld, parseDiffNew } from '@/lib/diff-parse';

interface MobileDiffViewProps {
  // Which file is open (null = closed)
  expandedFile: string | null;
  expandedSummary: FileDiffSummary | undefined;
  expandedDiffContent: string | undefined;
  ExpandedIcon: ComponentType<{ className?: string }>;
  onClose: () => void;
  onFileSelect: (path: string) => void;

  // Ordered file set — drives prev/next and the position indicator. Same array
  // the review file list renders, so the order matches what the user just saw.
  filteredDiffs: FileDiffSummary[];
  summaries: FileDiffSummary[];

  // Read-only diff view callbacks + state
  loadingDiff: string | null;
  diffCache: Map<string, string>;
  prThreads: PRReviewThread[] | undefined;
  requestFullDiff: (
    filePath: string,
  ) => Promise<{ oldValue: string; newValue: string; rawDiff?: string } | null>;
  handleResolveConflict: (blockId: number, resolution: 'ours' | 'theirs' | 'both') => Promise<void>;
}

/**
 * Full-screen, read-only diff overlay for mobile — the second drill-down level
 * after the review file list. Mirrors the `mobile-review-overlay` pattern in
 * `mobile/ChatView.tsx` (a plain `fixed inset-0` layer, NOT a Radix Dialog) so
 * the two review levels feel like one navigation stack rather than a modal
 * stacked on an overlay.
 *
 * The desktop counterpart is `DiffViewerModal` (centered Dialog + 280px file
 * tree). The shared core is `ExpandedDiffView`; this view drops the file-tree
 * sidebar (redundant — the user came from the file list) and all staging /
 * line-selection affordances (mobile is review-only), and replaces sidebar
 * navigation with prev/next arrows over `filteredDiffs`.
 *
 * The chrome switch lives in `ExpandedDiffPresenter` (`useIsMobile()`).
 */
export function MobileDiffView({
  expandedFile,
  expandedSummary,
  expandedDiffContent,
  ExpandedIcon,
  onClose,
  onFileSelect,
  filteredDiffs,
  summaries,
  loadingDiff,
  diffCache,
  prThreads,
  requestFullDiff,
  handleResolveConflict,
}: MobileDiffViewProps) {
  const { t } = useTranslation();

  if (!expandedFile) return null;

  // Index of the open file within the same ordered set the list shows. -1 when
  // an active filter excludes the open file — then prev/next are disabled and
  // the position label is hidden, but the diff is still readable.
  const currentIndex = filteredDiffs.findIndex((d) => d.path === expandedFile);
  const canPrev = currentIndex > 0;
  const canNext = currentIndex >= 0 && currentIndex < filteredDiffs.length - 1;

  const goPrev = () => {
    if (canPrev) onFileSelect(filteredDiffs[currentIndex - 1].path);
  };
  const goNext = () => {
    if (canNext) onFileSelect(filteredDiffs[currentIndex + 1].path);
  };

  return (
    <div
      className="bg-background fixed inset-0 z-[60] flex flex-col"
      data-testid="mobile-diff-overlay"
    >
      {/* Navigation bar — back + position + prev/next. The file name and view
          controls live in ExpandedDiffView's own header just below. */}
      <header className="border-border flex h-12 shrink-0 items-center gap-1 border-b px-2">
        <Button
          variant="ghost"
          size="icon"
          onClick={onClose}
          aria-label={t('common.back', 'Back')}
          data-testid="mobile-diff-back"
        >
          <ArrowLeft className="icon-lg" />
        </Button>
        <div className="min-w-0 flex-1" />
        {currentIndex >= 0 && (
          <span
            className="text-muted-foreground shrink-0 px-1 text-xs tabular-nums"
            data-testid="mobile-diff-position"
          >
            {currentIndex + 1}/{filteredDiffs.length}
          </span>
        )}
        <Button
          variant="ghost"
          size="icon"
          onClick={goPrev}
          disabled={!canPrev}
          aria-label={t('review.previousFile', 'Previous file')}
          data-testid="mobile-diff-prev"
        >
          <ChevronLeft className="icon-lg" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={goNext}
          disabled={!canNext}
          aria-label={t('review.nextFile', 'Next file')}
          data-testid="mobile-diff-next"
        >
          <ChevronRight className="icon-lg" />
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-hidden">
        <ExpandedDiffView
          filePath={expandedSummary?.path || ''}
          oldValue={expandedDiffContent ? parseDiffOld(expandedDiffContent) : ''}
          newValue={expandedDiffContent ? parseDiffNew(expandedDiffContent) : ''}
          icon={ExpandedIcon}
          loading={loadingDiff === expandedFile}
          rawDiff={expandedDiffContent}
          files={summaries}
          diffCache={diffCache}
          prReviewThreads={prThreads}
          onRequestFullDiff={requestFullDiff}
          onResolveConflict={handleResolveConflict}
          initialViewMode="unified"
          /* Read-only: no `selectable`, `onStagePatch`, selection signals, or
             `onClose` (the nav-bar back button is the single close affordance,
             so ExpandedDiffView does not render its own X). */
        />
      </div>
    </div>
  );
}
