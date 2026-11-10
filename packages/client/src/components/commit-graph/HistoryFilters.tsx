import { ArrowUpDown, GitBranch, User, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { FilterMultiSelect, type MultiSelectOption } from '@/components/ui/filter-multi-select';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select';
import type { GraphBranchScope } from '@/lib/api/git';
import type { CommitSyncFilter } from '@/lib/git-history-search';

/** The scope the graph opens with: merged branches hidden. */
export const DEFAULT_GRAPH_BRANCH_SCOPE: GraphBranchScope = 'unmerged';

export function HistoryFilters({
  branchScope,
  onBranchScopeChange,
  syncFilter,
  onToggleSyncFilter,
  authors,
  authorOptions,
  onAuthorsChange,
  onAuthorOpenChange,
  authorsLoading,
  hasMoreAuthors,
  onLoadMoreAuthors,
}: {
  branchScope: GraphBranchScope;
  onBranchScopeChange: (scope: GraphBranchScope) => void;
  syncFilter: CommitSyncFilter;
  onToggleSyncFilter: (filter: Exclude<CommitSyncFilter, 'all'>) => void;
  authors: string[];
  authorOptions: MultiSelectOption[];
  onAuthorsChange: (authors: string[]) => void;
  onAuthorOpenChange: (open: boolean) => void;
  authorsLoading?: boolean;
  hasMoreAuthors?: boolean;
  onLoadMoreAuthors?: () => void;
}) {
  const { t } = useTranslation();
  const scopeLabels: Record<GraphBranchScope, string> = {
    unmerged: t('graph.unmergedBranches', 'Unmerged branches'),
    all: t('graph.allBranches', 'All branches'),
    current: t('graph.currentBranchScope', 'Current branch'),
  };
  const statusLabels = {
    all: t('graph.allCommits', 'All commits'),
    pull: t('graph.pendingPull', 'Pending pull'),
    push: t('graph.pendingPush', 'Pending push'),
  };
  const setStatus = (next: CommitSyncFilter) => {
    if (next === syncFilter) return;
    if (next !== 'all') onToggleSyncFilter(next);
    else if (syncFilter !== 'all') onToggleSyncFilter(syncFilter);
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="history-filter-bar">
      <Select
        value={branchScope}
        onValueChange={(value) => onBranchScopeChange(value as GraphBranchScope)}
      >
        <SelectTrigger size="xs" className="w-auto gap-1" data-testid="graph-toggle-all-branches">
          <GitBranch className="icon-xs opacity-70" />
          <span>{scopeLabels[branchScope]}</span>
        </SelectTrigger>
        <SelectContent>
          {(['unmerged', 'all', 'current'] as const).map((scope) => (
            <SelectItem
              key={scope}
              value={scope}
              className="text-xs"
              data-testid={`graph-branch-scope-${scope}`}
            >
              {scopeLabels[scope]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={syncFilter} onValueChange={(value) => setStatus(value as CommitSyncFilter)}>
        <SelectTrigger size="xs" className="w-auto gap-1" data-testid="graph-filter-status">
          <ArrowUpDown className="icon-xs opacity-70" />
          <span>{statusLabels[syncFilter]}</span>
        </SelectTrigger>
        <SelectContent>
          {(['all', 'pull', 'push'] as const).map((status) => (
            <SelectItem
              key={status}
              value={status}
              className="text-xs"
              data-testid={`graph-filter-${status}`}
            >
              {statusLabels[status]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <FilterMultiSelect
        icon={<User className="icon-xs opacity-70" />}
        label={t('graph.author', 'Author')}
        options={authorOptions}
        selected={authors}
        onChange={onAuthorsChange}
        onOpenChange={onAuthorOpenChange}
        searchPlaceholder={t('graph.authorPlaceholder', 'Name or email')}
        emptyText={t('graph.noAuthors', 'No authors found')}
        footer={
          (authorsLoading || hasMoreAuthors) && (
            <button
              type="button"
              disabled={authorsLoading}
              onClick={onLoadMoreAuthors}
              className="text-muted-foreground hover:text-foreground w-full border-t px-2 py-2 text-xs disabled:opacity-50"
              data-testid="graph-author-load-more"
            >
              {authorsLoading
                ? t('history.loadingMore', 'Loading more…')
                : t('graph.loadMoreAuthors', 'Load more authors')}
            </button>
          )
        }
        testId="graph-filter-author"
      />
      {(authors.length > 0 ||
        syncFilter !== 'all' ||
        branchScope !== DEFAULT_GRAPH_BRANCH_SCOPE) && (
        <button
          type="button"
          onClick={() => {
            onAuthorsChange([]);
            setStatus('all');
            onBranchScopeChange(DEFAULT_GRAPH_BRANCH_SCOPE);
          }}
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs transition-colors"
          data-testid="graph-filter-clear"
        >
          <X className="icon-xs" />
          {t('review.pullRequests.filter.clear', 'Clear')}
        </button>
      )}
    </div>
  );
}
