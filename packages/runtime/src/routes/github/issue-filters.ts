/**
 * The Issues panel's filters, as on GitHub's issue list: author, labels,
 * projects, milestones, assignees, issue types and the sort order. They become
 * qualifiers of GitHub's advanced issue search (`ISSUE_ADVANCED`), so every
 * filter applies to the whole repository, not to the loaded page.
 *
 * Values come from the query string and end up inside a search query, so each
 * one is normalized by {@link qualifierValue}: a quote cannot close the value
 * early and add qualifiers of its own.
 */

import type { PRSortKey } from '@funny/shared';
import type { Context } from 'hono';

export interface IssueFilters {
  labels: string[];
  authors: string[];
  assignees: string[];
  milestones: string[];
  types: string[];
  /** `owner/number`, what the `project:` qualifier takes. */
  projects: string[];
  sort: PRSortKey;
}

const SORT_QUALIFIERS: Record<PRSortKey, string> = {
  newest: 'created-desc',
  oldest: 'created-asc',
  'recently-updated': 'updated-desc',
  'least-recently-updated': 'updated-asc',
  'most-commented': 'comments-desc',
};

/** REST search takes the sort as `sort` + `order` parameters instead of a qualifier. */
export function issueRestSort(key: PRSortKey) {
  const [sort, order] = SORT_QUALIFIERS[key].split('-');
  return { sort, order };
}

function isSortKey(v: string | undefined): v is PRSortKey {
  return v !== undefined && Object.hasOwn(SORT_QUALIFIERS, v);
}

/** At most this many values per filter: GitHub caps a search query at 5 boolean operators per group anyway. */
const MAX_VALUES = 10;
const MAX_VALUE_LENGTH = 100;

/** Comma-separated query param → trimmed, de-duped, non-empty values (at most {@link MAX_VALUES}). */
function listQuery(raw: string | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  for (const v of raw.split(',')) {
    const t = v.trim().slice(0, MAX_VALUE_LENGTH);
    if (t) seen.add(t);
  }
  return [...seen].slice(0, MAX_VALUES);
}

const PROJECT_REF = /^[A-Za-z0-9-]{1,39}\/\d{1,9}$/;

export const EMPTY_ISSUE_FILTERS: IssueFilters = {
  labels: [],
  authors: [],
  assignees: [],
  milestones: [],
  types: [],
  projects: [],
  sort: 'newest',
};

export function readIssueFilters(c: Context): IssueFilters {
  const sort = c.req.query('sort');
  return {
    labels: listQuery(c.req.query('labels')),
    authors: listQuery(c.req.query('authors')),
    assignees: listQuery(c.req.query('assignees')),
    milestones: listQuery(c.req.query('milestones')),
    types: listQuery(c.req.query('types')),
    projects: listQuery(c.req.query('projects')).filter((p) => PROJECT_REF.test(p)),
    sort: isSortKey(sort) ? sort : 'newest',
  };
}

/**
 * A qualifier value: quotes and control characters dropped, and the value
 * quoted when it holds a character the search syntax reads (space, comma,
 * parenthesis, colon), as labels such as `ENV · PROD` do.
 */
export function qualifierValue(v: string): string {
  // oxlint-disable-next-line no-control-regex -- control characters are what is removed
  const clean = v.replace(/["\u0000-\u001f\u007f]/g, '').trim();
  return /[\s,():]/.test(clean) ? `"${clean}"` : clean;
}

/** `name:value`, or nothing when the value is empty once cleaned. */
function qualifierTerm(name: string, value: string): string[] {
  const v = qualifierValue(value);
  return v ? [`${name}:${v}`] : [];
}

/** `name:a` for one value, `(name:a OR name:b)` for several: any of them matches. */
function anyOf(name: string, values: string[]): string[] {
  const terms = values.flatMap((v) => qualifierTerm(name, v));
  if (terms.length <= 1) return terms;
  return [`(${terms.join(' OR ')})`];
}

/**
 * The search terms of the filters. Labels must ALL be on the issue (as when
 * several labels are picked on GitHub); for the other filters ANY selected
 * value matches. The sort qualifier comes last.
 */
export function issueFilterTerms(filters: IssueFilters): string[] {
  return [
    ...filters.labels.flatMap((l) => qualifierTerm('label', l)),
    ...anyOf('author', filters.authors),
    ...anyOf('assignee', filters.assignees),
    ...anyOf('milestone', filters.milestones),
    ...anyOf('type', filters.types),
    ...anyOf('project', filters.projects),
    `sort:${SORT_QUALIFIERS[filters.sort]}`,
  ];
}
