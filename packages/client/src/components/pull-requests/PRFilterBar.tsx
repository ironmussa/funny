import type { PRFilterOptions, PRSortKey } from '@funny/shared';
import {
  ArrowUpDown,
  Check,
  ChevronDown,
  CircleDot,
  Tag,
  User,
  UserCheck,
  Eye,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
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

interface MultiSelectOption {
  /** The value sent to the API (label name or user login). */
  value: string;
  /** The display label. */
  label: string;
  /** Optional color dot (labels) — a hex string without the leading `#`. */
  color?: string;
  /** Optional avatar (users). */
  avatarUrl?: string;
}

interface MultiSelectProps {
  icon: React.ReactNode;
  label: string;
  options: MultiSelectOption[];
  selected: string[];
  onChange: (next: string[]) => void;
  searchPlaceholder: string;
  emptyText: string;
  disabled?: boolean;
  testId: string;
}

/** A searchable multi-select chip: click toggles membership without closing. */
function MultiSelect({
  icon,
  label,
  options,
  selected,
  onChange,
  searchPlaceholder,
  emptyText,
  disabled,
  testId,
}: MultiSelectProps) {
  const toggle = (value: string) => {
    onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]);
  };
  const active = selected.length > 0;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          data-testid={testId}
          className={cn(
            'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs whitespace-nowrap transition-colors disabled:opacity-50',
            active
              ? 'bg-accent text-accent-foreground border-accent-foreground/20'
              : 'border-border text-muted-foreground hover:bg-accent/50 hover:text-foreground bg-transparent',
          )}
        >
          {icon}
          <span>{label}</span>
          {active && (
            <span className="bg-primary text-primary-foreground ml-0.5 rounded-full px-1 text-[9px] leading-4 font-semibold">
              {selected.length}
            </span>
          )}
          <ChevronDown className="icon-xs opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[240px] p-0">
        <Command
          filter={(value, search) => (value.toLowerCase().includes(search.toLowerCase()) ? 1 : 0)}
        >
          <CommandInput
            placeholder={searchPlaceholder}
            className="h-9 text-xs"
            data-testid={`${testId}-search`}
          />
          <CommandList>
            <CommandEmpty>{emptyText}</CommandEmpty>
            <CommandGroup>
              {options.map((opt) => {
                const isActive = selected.includes(opt.value);
                return (
                  <CommandItem
                    key={opt.value}
                    value={opt.label}
                    onSelect={() => toggle(opt.value)}
                    className="text-xs"
                    data-testid={`${testId}-option-${opt.value}`}
                  >
                    <span
                      className={cn(
                        'flex h-3.5 w-3.5 items-center justify-center rounded-sm border',
                        isActive
                          ? 'bg-primary border-primary text-primary-foreground'
                          : 'border-muted-foreground/30',
                      )}
                    >
                      {isActive && <Check className="icon-2xs" />}
                    </span>
                    {opt.color !== undefined && (
                      <span
                        className="size-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: `#${opt.color}` }}
                      />
                    )}
                    {opt.avatarUrl && (
                      <img src={opt.avatarUrl} alt="" className="size-3.5 shrink-0 rounded-full" />
                    )}
                    <span className="flex-1 truncate">{opt.label}</span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

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

      <MultiSelect
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
      <MultiSelect
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
      <MultiSelect
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
      <MultiSelect
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
