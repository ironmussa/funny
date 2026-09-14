import type { PRFilterOptions, PRSortKey } from '@funny/shared';
import { ArrowUpDown, CircleDot, Tag, User, UserCheck, Eye, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { FilterMultiSelect, type MultiSelectOption } from '@/components/ui/filter-multi-select';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select';
import { cn } from '@/lib/utils';

/** The full set of PR filter/sort state owned by the parent. */
export interface PRFilterState {
  sort: PRSortKey;
  labels: string[];
  authors: string[];
  assignees: string[];
  reviewers: string[];
}

export const EMPTY_PR_FILTERS: PRFilterState = {
  sort: 'newest',
  labels: [],
  authors: [],
  assignees: [],
  reviewers: [],
};

/** True when any label/author/assignee/reviewer filter is active (sort excluded). */
export function hasActivePRFilters(f: PRFilterState): boolean {
  return (
    f.labels.length > 0 || f.authors.length > 0 || f.assignees.length > 0 || f.reviewers.length > 0
  );
}

const SORT_KEYS: PRSortKey[] = [
  'newest',
  'oldest',
  'recently-updated',
  'least-recently-updated',
  'most-commented',
];

/** Open/closed/all state filter — mirrors the GitHub `state` query param. */
export type PRStateFilter = 'open' | 'closed' | 'all';

const STATE_KEYS: PRStateFilter[] = ['open', 'closed', 'all'];

interface PRFilterBarProps {
  value: PRFilterState;
  onChange: (next: PRFilterState) => void;
  options: PRFilterOptions | null;
  optionsLoading?: boolean;
  /** Open/closed/all state. */
  state: PRStateFilter;
  onStateChange: (next: PRStateFilter) => void;
  /** Hide the state dropdown (e.g. in branch-focus mode where state is forced). */
  showState?: boolean;
  /** Include the default tab-level separator/padding when rendered as a standalone row. */
  showBorder?: boolean;
  className?: string;
}

export function PRFilterBar({
  value,
  onChange,
  options,
  optionsLoading,
  state,
  onStateChange,
  showState = true,
  showBorder = true,
  className,
}: PRFilterBarProps) {
  const { t } = useTranslation();

  const stateLabel = (s: PRStateFilter): string =>
    ({
      open: t('review.pullRequests.open', 'Open'),
      closed: t('review.pullRequests.closed', 'Closed'),
      all: t('review.pullRequests.all', 'All'),
    })[s];

  const sortLabel = (key: PRSortKey): string =>
    ({
      newest: t('review.pullRequests.sort.newest', 'Newest'),
      oldest: t('review.pullRequests.sort.oldest', 'Oldest'),
      'recently-updated': t('review.pullRequests.sort.recentlyUpdated', 'Recently updated'),
      'least-recently-updated': t(
        'review.pullRequests.sort.leastRecentlyUpdated',
        'Least recently updated',
      ),
      'most-commented': t('review.pullRequests.sort.mostCommented', 'Most commented'),
    })[key];

  const labelOptions: MultiSelectOption[] = (options?.labels ?? []).map((l) => ({
    value: l.name,
    label: l.name,
    color: l.color,
  }));
  const userOptions: MultiSelectOption[] = (options?.users ?? []).map((u) => ({
    value: u.login,
    label: u.login,
    avatarUrl: u.avatar_url,
  }));

  const usersDisabled = optionsLoading || userOptions.length === 0;
  const anyActive = hasActivePRFilters(value);

  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-1.5',
        showBorder && 'border-sidebar-border border-b px-2 py-1.5',
        className,
      )}
      data-testid="prs-filter-bar"
    >
      {showState && (
        <Select value={state} onValueChange={(v) => onStateChange(v as PRStateFilter)}>
          <SelectTrigger size="xs" className="w-auto gap-1" data-testid="prs-state-trigger">
            <CircleDot className="icon-xs opacity-70" />
            <span>{stateLabel(state)}</span>
          </SelectTrigger>
          <SelectContent>
            {STATE_KEYS.map((s) => (
              <SelectItem key={s} value={s} className="text-xs" data-testid={`prs-filter-${s}`}>
                {stateLabel(s)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      <Select
        value={value.sort}
        onValueChange={(v) => onChange({ ...value, sort: v as PRSortKey })}
      >
        <SelectTrigger size="xs" className="w-auto gap-1" data-testid="prs-sort-trigger">
          <ArrowUpDown className="icon-xs opacity-70" />
          <span>{sortLabel(value.sort)}</span>
        </SelectTrigger>
        <SelectContent>
          {SORT_KEYS.map((key) => (
            <SelectItem key={key} value={key} className="text-xs" data-testid={`prs-sort-${key}`}>
              {sortLabel(key)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <FilterMultiSelect
        icon={<Tag className="icon-xs opacity-70" />}
        label={t('review.pullRequests.filter.labels', 'Labels')}
        options={labelOptions}
        selected={value.labels}
        onChange={(labels) => onChange({ ...value, labels })}
        searchPlaceholder={t('review.pullRequests.filter.searchLabels', 'Search labels…')}
        emptyText={t('review.pullRequests.filter.noLabels', 'No labels')}
        disabled={optionsLoading || labelOptions.length === 0}
        testId="prs-filter-labels"
      />
      <FilterMultiSelect
        icon={<User className="icon-xs opacity-70" />}
        label={t('review.pullRequests.filter.author', 'Author')}
        options={userOptions}
        selected={value.authors}
        onChange={(authors) => onChange({ ...value, authors })}
        searchPlaceholder={t('review.pullRequests.filter.searchUsers', 'Search users…')}
        emptyText={t('review.pullRequests.filter.noUsers', 'No users')}
        disabled={usersDisabled}
        testId="prs-filter-author"
      />
      <FilterMultiSelect
        icon={<UserCheck className="icon-xs opacity-70" />}
        label={t('review.pullRequests.filter.assignee', 'Assignee')}
        options={userOptions}
        selected={value.assignees}
        onChange={(assignees) => onChange({ ...value, assignees })}
        searchPlaceholder={t('review.pullRequests.filter.searchUsers', 'Search users…')}
        emptyText={t('review.pullRequests.filter.noUsers', 'No users')}
        disabled={usersDisabled}
        testId="prs-filter-assignee"
      />
      <FilterMultiSelect
        icon={<Eye className="icon-xs opacity-70" />}
        label={t('review.pullRequests.filter.reviewer', 'Reviewer')}
        options={userOptions}
        selected={value.reviewers}
        onChange={(reviewers) => onChange({ ...value, reviewers })}
        searchPlaceholder={t('review.pullRequests.filter.searchUsers', 'Search users…')}
        emptyText={t('review.pullRequests.filter.noUsers', 'No users')}
        disabled={usersDisabled}
        testId="prs-filter-reviewer"
      />

      {anyActive && (
        <button
          type="button"
          onClick={() =>
            onChange({ ...value, labels: [], authors: [], assignees: [], reviewers: [] })
          }
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs transition-colors"
          data-testid="prs-filter-clear"
        >
          <X className="icon-xs" />
          {t('review.pullRequests.filter.clear', 'Clear')}
        </button>
      )}
    </div>
  );
}
