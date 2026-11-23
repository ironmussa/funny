import { useTranslation } from 'react-i18next';

import { HistoryFilters } from '@/components/commit-graph/HistoryFilters';
import {
  TabToolbar,
  TabToolbarRefresh,
  TabToolbarSpacer,
} from '@/components/review-pane/TabToolbar';
import { ToolbarCount } from '@/components/review-pane/ToolbarCount';
import type { GraphBranchScope } from '@/lib/api/git';
import type { CommitSyncFilter } from '@/lib/git-history-search';

/** Toolbar: refresh, branch scope, sync filters, and a commit counter. */
export function GraphToolbar({
  logLoading,
  branchScope,
  commitCount,
  syncFilter,
  onToggleSyncFilter,
  authors,
  authorOptions,
  onAuthorsChange,
  onAuthorOpenChange,
  hasMoreAuthors,
  onLoadMoreAuthors,
  onRefresh,
  onBranchScopeChange,
}: {
  logLoading: boolean;
  branchScope: GraphBranchScope;
  commitCount: number;
  syncFilter: CommitSyncFilter;
  authors: string[];
  authorOptions: { value: string; label: string }[];
  onAuthorsChange: (authors: string[]) => void;
  onAuthorOpenChange: (open: boolean) => void;
  hasMoreAuthors: boolean;
  onLoadMoreAuthors: () => void;
  onToggleSyncFilter: (filter: Exclude<CommitSyncFilter, 'all'>) => void;
  onRefresh: () => void;
  onBranchScopeChange: (scope: GraphBranchScope) => void;
}) {
  const { t } = useTranslation();
  return (
    <TabToolbar wrap data-testid="graph-toolbar">
      <TabToolbarRefresh loading={logLoading} onRefresh={onRefresh} data-testid="graph-refresh" />
      <HistoryFilters
        branchScope={branchScope}
        onBranchScopeChange={onBranchScopeChange}
        syncFilter={syncFilter}
        onToggleSyncFilter={onToggleSyncFilter}
        authors={authors}
        authorOptions={authorOptions}
        onAuthorsChange={onAuthorsChange}
        onAuthorOpenChange={onAuthorOpenChange}
        authorsLoading={logLoading}
        hasMoreAuthors={hasMoreAuthors}
        onLoadMoreAuthors={onLoadMoreAuthors}
      />
      <TabToolbarSpacer />
      <ToolbarCount
        label={t('graph.commitCount', {
          count: commitCount,
          defaultValue: `${commitCount} commits`,
        })}
        testId="graph-count"
      />
    </TabToolbar>
  );
}
