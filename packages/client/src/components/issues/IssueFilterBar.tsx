import type { IssueFilterOptions, PRSortKey } from '@funny/shared';
import {
  ArrowUpDown,
  CircleDot,
  KanbanSquare,
  Layers,
  Milestone,
  Tag,
  User,
  UserCheck,
  X,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { FilterMultiSelect, type MultiSelectOption } from '@/components/ui/filter-multi-select';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select';

export type IssueState = 'open' | 'closed';

/** The Issues panel's filters, as on GitHub's issue list. Values are what GitHub's search takes. */
export interface IssueFilterState {
  sort: PRSortKey;
  authors: string[];
  labels: string[];
  /** `owner/number` of each project. */
  projects: string[];
  milestones: string[];
  assignees: string[];
  types: string[];
}

export const EMPTY_ISSUE_FILTERS: IssueFilterState = {
  sort: 'newest',
  authors: [],
  labels: [],
  projects: [],
  milestones: [],
  assignees: [],
  types: [],
};

const LIST_KEYS = ['authors', 'labels', 'projects', 'milestones', 'assignees', 'types'] as const;

/** True when any filter other than the sort is set. */
export function hasActiveIssueFilters(f: IssueFilterState): boolean {
  return LIST_KEYS.some((key) => f[key].length > 0);
}

const SORT_KEYS: PRSortKey[] = [
  'newest',
  'oldest',
  'recently-updated',
  'least-recently-updated',
  'most-commented',
];

const STATE_KEYS: IssueState[] = ['open', 'closed'];

/** GitHub's issue type color names → a theme status color for the dot. */
const TYPE_DOT_CLASS = new Map([
  ['RED', 'bg-status-error'],
  ['ORANGE', 'bg-status-warning'],
  ['YELLOW', 'bg-status-warning'],
  ['GREEN', 'bg-status-success'],
  ['BLUE', 'bg-status-info'],
  ['PURPLE', 'bg-status-violet'],
  ['PINK', 'bg-status-violet'],
]);

function useOptions(options: IssueFilterOptions | null) {
  const labels: MultiSelectOption[] = (options?.labels ?? []).map((l) => ({
    value: l.name,
    label: l.name,
    color: l.color,
  }));
  const users: MultiSelectOption[] = (options?.users ?? []).map((u) => ({
    value: u.login,
    label: u.login,
    avatarUrl: u.avatar_url,
  }));
  const projects: MultiSelectOption[] = (options?.projects ?? []).map((p) => ({
    value: `${p.owner}/${p.number}`,
    label: p.title,
  }));
  const milestones: MultiSelectOption[] = (options?.milestones ?? []).map((m) => ({
    value: m.title,
    label: m.title,
  }));
  const types = options?.types ?? [];
  return { labels, users, projects, milestones, types };
}

interface IssueFilterBarProps {
  value: IssueFilterState;
  onChange: (next: IssueFilterState) => void;
  options: IssueFilterOptions | null;
  optionsLoading?: boolean;
  state: IssueState;
  onStateChange: (next: IssueState) => void;
  /** Shown before the filters: the select-all checkbox. */
  leading?: ReactNode;
}

export function IssueFilterBar({
  value,
  onChange,
  options,
  optionsLoading,
  state,
  onStateChange,
  leading,
}: IssueFilterBarProps) {
  const { t } = useTranslation();
  const opts = useOptions(options);
  const set =
    <K extends keyof IssueFilterState>(key: K) =>
    (next: IssueFilterState[K]) =>
      onChange({ ...value, [key]: next });

  const stateLabel = (s: IssueState): string =>
    s === 'open' ? t('issues.open', 'Open') : t('issues.closed', 'Closed');
  const sortLabel = (key: PRSortKey): string =>
    ({
      newest: t('review.issues.sort.newest', 'Newest'),
      oldest: t('review.issues.sort.oldest', 'Oldest'),
      'recently-updated': t('review.issues.sort.recentlyUpdated', 'Recently updated'),
      'least-recently-updated': t(
        'review.issues.sort.leastRecentlyUpdated',
        'Least recently updated',
      ),
      'most-commented': t('review.issues.sort.mostCommented', 'Most commented'),
    })[key];

  const searchUsers = t('review.issues.filter.searchUsers', 'Search users…');
  const noUsers = t('review.issues.filter.noUsers', 'No users');
  const usersDisabled = optionsLoading || opts.users.length === 0;

  return (
    <div
      className="border-sidebar-border flex flex-wrap items-center gap-1.5 border-b px-2 py-1.5"
      data-testid="issues-filter-bar"
    >
      {leading}
      <Select
        value={state}
        onValueChange={(v) => {
          if (v === 'open' || v === 'closed') onStateChange(v);
        }}
      >
        <SelectTrigger size="xs" className="w-auto" data-testid="issues-state-trigger">
          <CircleDot className="icon-xs opacity-70" />
          <span>{stateLabel(state)}</span>
        </SelectTrigger>
        <SelectContent>
          {STATE_KEYS.map((s) => (
            <SelectItem key={s} value={s} textSize="xs" data-testid={`issues-filter-${s}`}>
              {stateLabel(s)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <FilterMultiSelect
        icon={<User className="icon-xs opacity-70" />}
        label={t('review.issues.filter.author', 'Author')}
        options={opts.users}
        selected={value.authors}
        onChange={set('authors')}
        searchPlaceholder={searchUsers}
        emptyText={noUsers}
        disabled={usersDisabled}
        testId="issues-filter-author"
      />
      <FilterMultiSelect
        icon={<Tag className="icon-xs opacity-70" />}
        label={t('review.issues.filter.labels', 'Labels')}
        options={opts.labels}
        selected={value.labels}
        onChange={set('labels')}
        searchPlaceholder={t('review.issues.filter.searchLabels', 'Search labels…')}
        emptyText={t('review.issues.filter.noLabels', 'No labels')}
        disabled={optionsLoading || opts.labels.length === 0}
        testId="issues-filter-labels"
      />
      <FilterMultiSelect
        icon={<KanbanSquare className="icon-xs opacity-70" />}
        label={t('review.issues.filter.projects', 'Projects')}
        options={opts.projects}
        selected={value.projects}
        onChange={set('projects')}
        searchPlaceholder={t('review.issues.filter.searchProjects', 'Search projects…')}
        emptyText={t('review.issues.filter.noProjects', 'No projects')}
        disabled={optionsLoading || opts.projects.length === 0}
        testId="issues-filter-projects"
      />
      <FilterMultiSelect
        icon={<Milestone className="icon-xs opacity-70" />}
        label={t('review.issues.filter.milestones', 'Milestones')}
        options={opts.milestones}
        selected={value.milestones}
        onChange={set('milestones')}
        searchPlaceholder={t('review.issues.filter.searchMilestones', 'Search milestones…')}
        emptyText={t('review.issues.filter.noMilestones', 'No milestones')}
        disabled={optionsLoading || opts.milestones.length === 0}
        testId="issues-filter-milestones"
      />
      <FilterMultiSelect
        icon={<UserCheck className="icon-xs opacity-70" />}
        label={t('review.issues.filter.assignees', 'Assignees')}
        options={opts.users}
        selected={value.assignees}
        onChange={set('assignees')}
        searchPlaceholder={searchUsers}
        emptyText={noUsers}
        disabled={usersDisabled}
        testId="issues-filter-assignees"
      />
      <IssueTypeFilter
        types={opts.types}
        selected={value.types}
        onChange={set('types')}
        disabled={optionsLoading || opts.types.length === 0}
      />

      <Select
        value={value.sort}
        // SAFETY: v comes from this Select, whose items are only SORT_KEYS, a PRSortKey[].
        onValueChange={(v) => onChange({ ...value, sort: v as PRSortKey })}
      >
        <SelectTrigger size="xs" className="w-auto" data-testid="issues-sort-trigger">
          <ArrowUpDown className="icon-xs opacity-70" />
          <span>{sortLabel(value.sort)}</span>
        </SelectTrigger>
        <SelectContent>
          {SORT_KEYS.map((key) => (
            <SelectItem key={key} value={key} textSize="xs" data-testid={`issues-sort-${key}`}>
              {sortLabel(key)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {hasActiveIssueFilters(value) && (
        <Button
          variant="ghost"
          size="xs"
          onClick={() => onChange({ ...EMPTY_ISSUE_FILTERS, sort: value.sort })}
          data-testid="issues-filter-clear"
        >
          <X className="icon-xs" />
          {t('review.issues.filter.clear', 'Clear')}
        </Button>
      )}
    </div>
  );
}

/** Issue types: GitHub names their colors (`RED`), so the dot uses a theme class, not a hex. */
function IssueTypeFilter({
  types,
  selected,
  onChange,
  disabled,
}: {
  types: IssueFilterOptions['types'];
  selected: string[];
  onChange: (next: string[]) => void;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const options: MultiSelectOption[] = types.map((type) => ({
    value: type.name,
    label: type.name,
    dotClassName: TYPE_DOT_CLASS.get(type.color) ?? 'bg-muted-foreground',
  }));
  return (
    <FilterMultiSelect
      icon={<Layers className="icon-xs opacity-70" />}
      label={t('review.issues.filter.types', 'Types')}
      options={options}
      selected={selected}
      onChange={onChange}
      searchPlaceholder={t('review.issues.filter.searchTypes', 'Search types…')}
      emptyText={t('review.issues.filter.noTypes', 'No types')}
      disabled={disabled}
      testId="issues-filter-types"
    />
  );
}
