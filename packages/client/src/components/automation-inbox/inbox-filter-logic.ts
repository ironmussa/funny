import type { InboxItem, RunTriageStatus } from '@funny/shared';
import { includesSearchText } from '@funny/shared/lib/text-search';

/** The status the list shows: one triage status, or every run. */
export type InboxStatus = RunTriageStatus | 'all';
type FindingsValue = 'with' | 'without';

export const DEFAULT_STATUS: InboxStatus = 'pending';

/** How many runs carry each filter value, as the filter chips show it. */
export type FilterCounts = Record<string, number>;

export function countBy<T>(items: T[], key: (item: T) => string) {
  const counts: FilterCounts = {};
  for (const item of items) {
    const k = key(item);
    counts[k] = (counts[k] ?? 0) + 1;
  }
  return counts;
}

export const findingsOf = (item: InboxItem): FindingsValue =>
  item.run.hasFindings ? 'with' : 'without';

/** A copy of `set` with `value` added, or removed when it was there. */
export function toggledSet(set: ReadonlySet<string>, value: string): Set<string> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

/** What the inbox list is narrowed by. An empty chip set means "any". */
export interface InboxCriteria {
  status: InboxStatus;
  findings: ReadonlySet<string>;
  runStates: ReadonlySet<string>;
  automations: ReadonlySet<string>;
  /** The trimmed search text; empty matches every run. */
  needle: string;
  caseSensitive: boolean;
}

const inChips = (chips: ReadonlySet<string>, value: string) => chips.size === 0 || chips.has(value);

const matchesStatus = (item: InboxItem, status: InboxStatus) =>
  status === 'all' || item.run.triageStatus === status;

const matchesChips = (item: InboxItem, criteria: InboxCriteria) =>
  inChips(criteria.findings, findingsOf(item)) &&
  inChips(criteria.runStates, item.run.status) &&
  inChips(criteria.automations, item.automation.id);

const matchesSearch = (item: InboxItem, needle: string, caseSensitive: boolean) =>
  !needle ||
  includesSearchText(item.automation.name, needle, caseSensitive) ||
  includesSearchText(item.thread.title, needle, caseSensitive);

export const matchesInboxCriteria = (item: InboxItem, criteria: InboxCriteria) =>
  matchesStatus(item, criteria.status) &&
  matchesChips(item, criteria) &&
  matchesSearch(item, criteria.needle, criteria.caseSensitive);

/** Whether anything but the search text narrows the list (what "reset" clears). */
export function hasActiveInboxFilters(
  projectFilter: string | null,
  status: InboxStatus,
  chipSets: ReadonlySet<string>[],
) {
  if (projectFilter) return true;
  if (status !== DEFAULT_STATUS) return true;
  return chipSets.some((chips) => chips.size > 0);
}
