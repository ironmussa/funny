import type { Project } from '@funny/shared';
import { Inbox } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { FilterDropdown } from '@/components/all-threads/FilterDropdown';
import { ProjectFilterPopover } from '@/components/all-threads/ProjectFilterPopover';
import { SearchBar } from '@/components/ui/search-bar';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select';

import { InboxSelectionControls } from './InboxSelectionControls';
import { RunStateDot, runStateLabel } from './RunStateDot';
import {
  INBOX_RUN_STATES,
  INBOX_STATUSES,
  type InboxFilters,
  type InboxStatus,
} from './use-inbox-filters';
import type { InboxSelection } from './use-inbox-selection';

/**
 * The row above the inbox list: the select-all checkbox, the status selector
 * and the filters on the left, then the search.
 */
export function InboxToolbar({
  filters,
  selection,
  projects,
  totalCount,
}: {
  filters: InboxFilters;
  selection: InboxSelection;
  /** The projects that have inbox runs. */
  projects: Project[];
  totalCount: number;
}) {
  const { t } = useTranslation();
  const count = filters.filtered.length;

  return (
    <div className="border-border/50 flex flex-wrap items-center gap-2 border-b px-4 py-2">
      <InboxSelectionControls selection={selection}>
        <InboxFilterControls filters={filters} projects={projects} />
      </InboxSelectionControls>
      <div className="bg-border h-4 w-px" />
      <SearchBar
        query={filters.search}
        onQueryChange={filters.setSearch}
        totalMatches={count}
        resultLabel={filters.search.trim() ? `${count}/${totalCount}` : ''}
        caseSensitive={filters.caseSensitive}
        onCaseSensitiveChange={filters.setCaseSensitive}
        onClose={filters.search ? () => filters.setSearch('') : undefined}
        autoFocus={false}
        placeholder={t('automationInbox.searchPlaceholder')}
        testIdPrefix="inbox-search"
        variant="outline"
        className="h-7 w-72 shrink-0"
      />
    </div>
  );
}

/**
 * The status the list shows (one at a time, each with its count, as GitHub's
 * Open / Closed), then the filters.
 */
function InboxFilterControls({
  filters,
  projects,
}: {
  filters: InboxFilters;
  /** The projects that have inbox runs. */
  projects: Project[];
}) {
  const { t } = useTranslation();
  const filteredProject = projects.find((p) => p.id === filters.projectFilter);
  const statusLabel = (status: InboxStatus) =>
    status === 'all'
      ? t('automationInbox.status.all', 'All')
      : t(`automationInbox.status.${status}`);

  return (
    <>
      <Select
        value={filters.status}
        onValueChange={(v) => {
          const status = INBOX_STATUSES.find((s) => s === v);
          if (status) filters.setStatus(status);
        }}
      >
        <SelectTrigger size="xs" className="w-auto" data-testid="inbox-status-trigger">
          <Inbox className="icon-xs opacity-70" />
          <span>{statusLabel(filters.status)}</span>
        </SelectTrigger>
        <SelectContent>
          {INBOX_STATUSES.map((status) => (
            <SelectItem
              key={status}
              value={status}
              textSize="xs"
              data-testid={`inbox-status-${status}`}
            >
              {statusLabel(status)}
              <span className="text-muted-foreground ml-1 tabular-nums">
                {filters.statusCounts[status] ?? 0}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {projects.length > 0 && (
        <ProjectFilterPopover
          open={filters.projectFilterOpen}
          onOpenChange={filters.setProjectFilterOpen}
          projects={projects}
          projectFilter={filters.projectFilter}
          filteredProjectName={filteredProject?.name}
          onChange={filters.setProjectFilter}
        />
      )}

      <FilterDropdown
        testId="inbox-run-state-filter"
        label={t('automationInbox.runState.label')}
        options={INBOX_RUN_STATES.map((state) => ({
          value: state,
          label: runStateLabel(t, state),
          icon: <RunStateDot state={state} />,
        }))}
        selected={filters.runStateFilter}
        onToggle={filters.toggleRunState}
        counts={filters.runStateCounts}
      />

      <FilterDropdown
        testId="inbox-findings-filter"
        label={t('automationInbox.findings')}
        options={[
          { value: 'with', label: t('automationInbox.hasFindings') },
          { value: 'without', label: t('automationInbox.noFindings') },
        ]}
        selected={filters.findingsFilter}
        onToggle={filters.toggleFindings}
        counts={filters.findingsCounts}
      />

      {filters.automations.length > 1 && (
        <FilterDropdown
          testId="inbox-automation-filter"
          label={t('automationInbox.automation')}
          options={filters.automations}
          selected={filters.automationFilter}
          onToggle={filters.toggleAutomation}
          counts={filters.automationCounts}
          search={{ placeholder: t('automationInbox.searchAutomation') }}
        />
      )}

      {filters.hasActiveFilters && (
        <button
          type="button"
          data-testid="inbox-clear-filters"
          onClick={filters.resetFilters}
          className="text-muted-foreground hover:text-foreground px-2 py-1 text-xs whitespace-nowrap transition-colors"
        >
          {t('allThreads.clearFilters')}
        </button>
      )}
    </>
  );
}
