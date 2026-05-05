import type { GitSyncState, Project, ThreadStatus } from '@funny/shared';
import { Archive, ArrowDown, ArrowUp, Check } from 'lucide-react';
import type { Dispatch, KeyboardEvent, RefObject, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';

import { FilterDropdown } from '@/components/all-threads/FilterDropdown';
import { ProjectFilterPopover } from '@/components/all-threads/ProjectFilterPopover';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { SearchBar } from '@/components/ui/search-bar';
import { getStatusLabels } from '@/lib/thread-utils';
import { cn } from '@/lib/utils';

type SortField = 'updated' | 'created';
type SortDir = 'desc' | 'asc';

interface Props {
  // search
  searchInputRef: RefObject<HTMLInputElement | null>;
  search: string;
  onSearchChange: (v: string) => void;
  caseSensitive: boolean;
  onCaseSensitiveChange: (v: boolean) => void;
  searchKeyDown: (e: KeyboardEvent) => void;
  filteredCount: number;
  totalCount: number;
  searchPlaceholder: string;

  // project filter
  projects: Project[];
  projectFilter: string | null;
  filteredProjectName?: string;
  projectFilterOpen: boolean;
  setProjectFilterOpen: (open: boolean) => void;
  onProjectFilterChange: (id: string | null) => void;

  // status / git / mode filters
  statusFilter: Set<string>;
  setStatusFilter: Dispatch<SetStateAction<Set<string>>>;
  gitFilter: Set<string>;
  setGitFilter: Dispatch<SetStateAction<Set<string>>>;
  modeFilter: Set<string>;
  setModeFilter: Dispatch<SetStateAction<Set<string>>>;
  statusCounts: Record<string, number>;
  gitCounts: Record<string, number>;
  threadStatuses: ThreadStatus[];
  gitStates: GitSyncState[];

  // sort
  sortField: SortField;
  setSortField: Dispatch<SetStateAction<SortField>>;
  sortDir: SortDir;
  setSortDir: Dispatch<SetStateAction<SortDir>>;

  // archived + reset
  showArchived: boolean;
  setShowArchived: Dispatch<SetStateAction<boolean>>;
  hasActiveFilters: boolean;
  onResetFilters: () => void;
}

const toggleFilter = (setter: Dispatch<SetStateAction<Set<string>>>) => (value: string) => {
  setter((prev) => {
    const next = new Set(prev);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next;
  });
};

export function AllThreadsToolbar(props: Props) {
  const { t } = useTranslation();
  const statusLabels = getStatusLabels(t);
  const {
    searchInputRef,
    search,
    onSearchChange,
    caseSensitive,
    onCaseSensitiveChange,
    searchKeyDown,
    filteredCount,
    totalCount,
    searchPlaceholder,
    projects,
    projectFilter,
    filteredProjectName,
    projectFilterOpen,
    setProjectFilterOpen,
    onProjectFilterChange,
    statusFilter,
    setStatusFilter,
    gitFilter,
    setGitFilter,
    modeFilter,
    setModeFilter,
    statusCounts,
    gitCounts,
    threadStatuses,
    gitStates,
    sortField,
    setSortField,
    sortDir,
    setSortDir,
    showArchived,
    setShowArchived,
    hasActiveFilters,
    onResetFilters,
  } = props;

  return (
    <div className="flex items-center gap-2 border-b border-border/50 px-4 py-2">
      <SearchBar
        inputRef={searchInputRef}
        query={search}
        onQueryChange={onSearchChange}
        totalMatches={filteredCount}
        resultLabel={search.trim() ? `${filteredCount}/${totalCount}` : ''}
        caseSensitive={caseSensitive}
        onCaseSensitiveChange={onCaseSensitiveChange}
        onInputKeyDown={searchKeyDown}
        onClose={search ? () => onSearchChange('') : undefined}
        autoFocus={false}
        placeholder={searchPlaceholder}
        testIdPrefix="all-threads-search"
        className="h-7 w-72 flex-shrink-0 rounded-md border border-input bg-transparent px-2"
      />

      <div className="h-4 w-px bg-border" />

      <ProjectFilterPopover
        open={projectFilterOpen}
        onOpenChange={setProjectFilterOpen}
        projects={projects}
        projectFilter={projectFilter}
        filteredProjectName={filteredProjectName}
        onChange={onProjectFilterChange}
      />

      <FilterDropdown
        testId="all-threads-status-filter"
        label={t('allThreads.filterStatus')}
        options={threadStatuses
          .filter((s) => (statusCounts[s] || 0) > 0)
          .map((s) => ({ value: s, label: statusLabels[s] }))}
        selected={statusFilter}
        onToggle={toggleFilter(setStatusFilter)}
        counts={statusCounts}
      />

      <FilterDropdown
        testId="all-threads-git-filter"
        label="Git"
        options={gitStates
          .filter((gs) => (gitCounts[gs] || 0) > 0)
          .map((gs) => ({ value: gs, label: t(`gitStatus.${gs}`) }))}
        selected={gitFilter}
        onToggle={toggleFilter(setGitFilter)}
        counts={gitCounts}
      />

      <FilterDropdown
        label={t('allThreads.filterMode')}
        options={[
          { value: 'local', label: t('thread.mode.local') },
          { value: 'worktree', label: t('thread.mode.worktree') },
        ]}
        selected={modeFilter}
        onToggle={toggleFilter(setModeFilter)}
      />

      <div className="h-4 w-px bg-border" />

      <SortPopover
        sortField={sortField}
        setSortField={setSortField}
        sortDir={sortDir}
        setSortDir={setSortDir}
      />

      <button
        data-testid="all-threads-show-archived"
        onClick={() => setShowArchived(!showArchived)}
        className={cn(
          'inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md border transition-colors whitespace-nowrap',
          showArchived
            ? 'bg-status-warning/10 border-status-warning/20 text-status-warning/80'
            : 'bg-transparent text-muted-foreground border-border hover:bg-accent/50 hover:text-foreground',
        )}
      >
        <Archive className="icon-xs" />
        {t('allThreads.showArchived')}
      </button>

      {hasActiveFilters && (
        <button
          data-testid="all-threads-clear-filters"
          onClick={onResetFilters}
          className="whitespace-nowrap px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          {t('allThreads.clearFilters')}
        </button>
      )}
    </div>
  );
}

function SortPopover({
  sortField,
  setSortField,
  sortDir,
  setSortDir,
}: {
  sortField: SortField;
  setSortField: Dispatch<SetStateAction<SortField>>;
  sortDir: SortDir;
  setSortDir: Dispatch<SetStateAction<SortDir>>;
}) {
  const { t } = useTranslation();
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          data-testid="all-threads-sort"
          className="inline-flex items-center gap-1 whitespace-nowrap rounded-md border border-border bg-transparent px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
        >
          {t('allThreads.sortLabel')}:{' '}
          {sortField === 'updated' ? t('allThreads.sortUpdated') : t('allThreads.sortCreated')}
          {sortDir === 'desc' ? <ArrowDown className="icon-xs" /> : <ArrowUp className="icon-xs" />}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto min-w-[140px] p-1">
        <SortFieldOption
          field="updated"
          activeField={sortField}
          onSelect={() => setSortField('updated')}
          label={t('allThreads.sortUpdated')}
        />
        <SortFieldOption
          field="created"
          activeField={sortField}
          onSelect={() => setSortField('created')}
          label={t('allThreads.sortCreated')}
        />
        <div className="my-1 h-px bg-border" />
        <button
          data-testid="all-threads-sort-direction"
          onClick={() => setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'))}
          className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent hover:text-accent-foreground"
        >
          {sortDir === 'desc' ? (
            <>
              <ArrowDown className="icon-xs" />
              {t('allThreads.sortDesc')}
            </>
          ) : (
            <>
              <ArrowUp className="icon-xs" />
              {t('allThreads.sortAsc')}
            </>
          )}
        </button>
      </PopoverContent>
    </Popover>
  );
}

function SortFieldOption({
  field,
  activeField,
  onSelect,
  label,
}: {
  field: SortField;
  activeField: SortField;
  onSelect: () => void;
  label: string;
}) {
  const isActive = field === activeField;
  return (
    <button
      onClick={onSelect}
      className={cn(
        'flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded-sm transition-colors text-left',
        'hover:bg-accent hover:text-accent-foreground',
      )}
    >
      <span
        className={cn(
          'flex h-3.5 w-3.5 items-center justify-center rounded-full border',
          isActive
            ? 'bg-primary border-primary text-primary-foreground'
            : 'border-muted-foreground/30',
        )}
      >
        {isActive && <Check className="icon-2xs" />}
      </span>
      {label}
    </button>
  );
}
