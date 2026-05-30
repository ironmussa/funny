import type { FileDiffSummary } from '@funny/shared';
import type { ComponentProps } from 'react';
import { useTranslation } from 'react-i18next';

import { SearchBar } from '@/components/ui/search-bar';
import { TabsContent } from '@/components/ui/tabs';

import { PRSummaryCard } from '../PRSummaryCard';
import { ChangesFilesPanel } from './ChangesFilesPanel';
import { ChangesToolbar } from './ChangesToolbar';
import { CommitDraftPanel } from './CommitDraftPanel';

interface ReviewChangesTabProps {
  /** Diff-load truncation info — surfaces the yellow banner when files were dropped. */
  truncatedInfo: { truncated: boolean; total: number };
  /** Used for truncation banner counts and file-list state. */
  summaries: FileDiffSummary[];
  /** Pre-built PRSummaryCard props, or null to hide. */
  prSummary: ComponentProps<typeof PRSummaryCard> | null;
  /** SearchBar bundle for filtering the file list. */
  search: ComponentProps<typeof SearchBar>;
  toolbar: ComponentProps<typeof ChangesToolbar>;
  filesPanel: ComponentProps<typeof ChangesFilesPanel>;
  commitDraft: ComponentProps<typeof CommitDraftPanel>;
}

/**
 * The "Changes" tab body — toolbar, file search, file tree, and commit draft.
 * Extracted from ReviewPane.tsx so the orchestrator stops directly importing
 * five children just to forward their props.
 */
/**
 * Inner content of the Changes tab (no Radix Tabs wrapper). Use this directly
 * when the tab gating is handled by a different system (e.g. dockview panels).
 */
export function ReviewChangesTabContent({
  truncatedInfo,
  summaries,
  prSummary,
  search,
  toolbar,
  filesPanel,
  commitDraft,
}: ReviewChangesTabProps) {
  const { t } = useTranslation();

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        {truncatedInfo.truncated && (
          <div className="border-b border-sidebar-border bg-yellow-500/10 px-3 py-1.5 text-xs text-yellow-600 dark:text-yellow-400">
            {t('review.truncatedWarning', {
              shown: summaries.length,
              total: truncatedInfo.total,
              defaultValue: `Showing ${summaries.length} of ${truncatedInfo.total} files. Some files were excluded.`,
            })}
          </div>
        )}

        {prSummary && <PRSummaryCard {...prSummary} />}

        <ChangesToolbar {...toolbar} />

        <div className="border-b border-sidebar-border bg-background px-2 py-1">
          <SearchBar {...search} />
        </div>

        <ChangesFilesPanel {...filesPanel} />

        <CommitDraftPanel {...commitDraft} />
      </div>
    </div>
  );
}

/**
 * Legacy entry point used by ReviewPane.tsx — wraps the content in a Radix
 * Tabs `TabsContent` so it can be slotted into the existing Tabs UI. New
 * callers should prefer `ReviewChangesTabContent`.
 */
export function ReviewChangesTab(props: ReviewChangesTabProps) {
  return (
    <TabsContent
      value="changes"
      className="flex min-h-0 flex-1 data-[state=inactive]:hidden"
      forceMount
    >
      <ReviewChangesTabContent {...props} />
    </TabsContent>
  );
}
