import type { InboxItem, RunTriageStatus } from '@funny/shared';
import { useMemo, useState } from 'react';

import {
  countBy,
  DEFAULT_STATUS,
  findingsOf,
  hasActiveInboxFilters,
  matchesInboxCriteria,
  toggledSet,
  type FilterCounts,
  type InboxStatus,
} from './inbox-filter-logic';

export type { InboxStatus } from './inbox-filter-logic';

const TRIAGE_STATUSES: RunTriageStatus[] = ['pending', 'reviewed', 'dismissed'];
export const INBOX_STATUSES: InboxStatus[] = [...TRIAGE_STATUSES, 'all'];
/** The run states the inbox lists (archived runs leave it). */
export type InboxRunState = 'running' | 'completed' | 'failed';
export const INBOX_RUN_STATES: InboxRunState[] = ['running', 'completed', 'failed'];

/** One multi-select chip filter: the chosen values (none means "any"). */
function useChipFilter() {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const toggle = (value: string) => setSelected((prev) => toggledSet(prev, value));
  const reset = () => setSelected(new Set());
  return { selected, toggle, reset };
}

/** What each chip would list. Counts follow the project, not the other filters. */
function useInboxCounts(inbox: InboxItem[], inProject: InboxItem[]) {
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
  return { statusCounts, findingsCounts, runStateCounts, automationCounts, automations };
}

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
  const findings = useChipFilter();
  const runState = useChipFilter();
  const automation = useChipFilter();
  const findingsFilter = findings.selected;
  const runStateFilter = runState.selected;
  const automationFilter = automation.selected;

  // Counts follow the project, so a chip shows what choosing it would list.
  const inProject = useMemo(
    () => (projectFilter ? inbox.filter((i) => i.thread.projectId === projectFilter) : inbox),
    [inbox, projectFilter],
  );

  const filtered = useMemo(() => {
    const criteria = {
      status,
      findings: findingsFilter,
      runStates: runStateFilter,
      automations: automationFilter,
      needle: search.trim(),
      caseSensitive,
    };
    return inProject.filter((item) => matchesInboxCriteria(item, criteria));
  }, [inProject, status, findingsFilter, runStateFilter, automationFilter, search, caseSensitive]);

  const counts = useInboxCounts(inbox, inProject);

  const resetFilters = () => {
    setProjectFilter(null);
    setStatus(DEFAULT_STATUS);
    findings.reset();
    runState.reset();
    automation.reset();
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
    toggleFindings: findings.toggle,
    runStateFilter,
    toggleRunState: runState.toggle,
    automationFilter,
    toggleAutomation: automation.toggle,
    filtered,
    ...counts,
    hasActiveFilters: hasActiveInboxFilters(projectFilter, status, [
      findingsFilter,
      runStateFilter,
      automationFilter,
    ]),
    resetFilters,
  };
}

export type InboxFilters = ReturnType<typeof useInboxFilters>;
