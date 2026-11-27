import type { InboxItem, RunTriageStatus } from '@funny/shared';
import { includesSearchText } from '@funny/shared/lib/text-search';
import { useMemo, useState } from 'react';

export const TRIAGE_STATUSES: RunTriageStatus[] = ['pending', 'reviewed', 'dismissed'];
/** The status the list shows: one triage status, or every run. */
export type InboxStatus = RunTriageStatus | 'all';
export const INBOX_STATUSES: InboxStatus[] = [...TRIAGE_STATUSES, 'all'];
export type FindingsValue = 'with' | 'without';
/** The run states the inbox lists (archived runs leave it). */
export type InboxRunState = 'running' | 'completed' | 'failed';
export const INBOX_RUN_STATES: InboxRunState[] = ['running', 'completed', 'failed'];

const DEFAULT_STATUS: InboxStatus = 'pending';

/** How many runs carry each filter value, as the filter chips show it. */
export type FilterCounts = Record<string, number>;

function countBy<T>(items: T[], key: (item: T) => string) {
  const counts: FilterCounts = {};
  for (const item of items) {
    const k = key(item);
    counts[k] = (counts[k] ?? 0) + 1;
  }
  return counts;
}

const findingsOf = (item: InboxItem): FindingsValue => (item.run.hasFindings ? 'with' : 'without');

/**
 * The inbox's filters, laid out like the thread search's: a text search, a
 * project, one status (as GitHub's Open / Closed), and multi-select run state /
 * findings / automation chips (an empty set means "any"). Status starts on "pending",
 * the runs still to review.
 */
export function useInboxFilters(inbox: InboxItem[]) {
  const [search, setSearch] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [projectFilter, setProjectFilter] = useState<string | null>(null);
  const [projectFilterOpen, setProjectFilterOpen] = useState(false);
  const [status, setStatus] = useState<InboxStatus>(DEFAULT_STATUS);
  const [findingsFilter, setFindingsFilter] = useState<Set<string>>(() => new Set());
  const [runStateFilter, setRunStateFilter] = useState<Set<string>>(() => new Set());
  const [automationFilter, setAutomationFilter] = useState<Set<string>>(() => new Set());

  const toggle = (setter: (update: (prev: Set<string>) => Set<string>) => void) => (v: string) =>
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(v)) next.delete(v);
      else next.add(v);
      return next;
    });

  // Counts follow the project, so a chip shows what choosing it would list.
  const inProject = useMemo(
    () => (projectFilter ? inbox.filter((i) => i.thread.projectId === projectFilter) : inbox),
    [inbox, projectFilter],
  );

  const filtered = useMemo(() => {
    const needle = search.trim();
    return inProject.filter(
      (item) =>
        (status === 'all' || item.run.triageStatus === status) &&
        (findingsFilter.size === 0 || findingsFilter.has(findingsOf(item))) &&
        (runStateFilter.size === 0 || runStateFilter.has(item.run.status)) &&
        (automationFilter.size === 0 || automationFilter.has(item.automation.id)) &&
        (!needle ||
          includesSearchText(item.automation.name, needle, caseSensitive) ||
          includesSearchText(item.thread.title, needle, caseSensitive)),
    );
  }, [inProject, status, findingsFilter, runStateFilter, automationFilter, search, caseSensitive]);

  const statusCounts = useMemo<FilterCounts>(
    () => ({
      ...countBy(inProject, (i) => i.run.triageStatus),
      all: inProject.length,
    }),
    [inProject],
  );
  const findingsCounts = useMemo(() => countBy(inProject, findingsOf), [inProject]);
  const runStateCounts = useMemo(() => countBy(inProject, (i) => i.run.status), [inProject]);
  const automationCounts = useMemo(() => countBy(inProject, (i) => i.automation.id), [inProject]);
  const automations = useMemo(() => {
    const byId = new Map(inbox.map((i) => [i.automation.id, i.automation.name]));
    return [...byId].map(([value, label]) => ({ value, label }));
  }, [inbox]);

  const hasActiveFilters =
    !!projectFilter ||
    status !== DEFAULT_STATUS ||
    findingsFilter.size > 0 ||
    runStateFilter.size > 0 ||
    automationFilter.size > 0;

  const resetFilters = () => {
    setProjectFilter(null);
    setStatus(DEFAULT_STATUS);
    setFindingsFilter(new Set());
    setRunStateFilter(new Set());
    setAutomationFilter(new Set());
  };

  return {
    search,
    setSearch,
    caseSensitive,
    setCaseSensitive,
    projectFilter,
    setProjectFilter,
    projectFilterOpen,
    setProjectFilterOpen,
    status,
    setStatus,
    findingsFilter,
    toggleFindings: toggle(setFindingsFilter),
    runStateFilter,
    toggleRunState: toggle(setRunStateFilter),
    automationFilter,
    toggleAutomation: toggle(setAutomationFilter),
    filtered,
    statusCounts,
    findingsCounts,
    runStateCounts,
    automationCounts,
    automations,
    hasActiveFilters,
    resetFilters,
  };
}

export type InboxFilters = ReturnType<typeof useInboxFilters>;
