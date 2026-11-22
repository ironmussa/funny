/**
 * Pure matcher for the settings sidebar filter (openspec `settings-filter`).
 * No React: the sidebar, the cross-surface hint and the per-row dimming all
 * call it with the same inputs.
 */
import { normalizeSearchText } from '@funny/shared/lib/text-search';

import {
  SETTINGS_INDEX,
  SETTINGS_PAGE_KEYWORDS,
  type IndexedSetting,
  type SettingsIndexEntry,
  type SettingsScope,
} from './settings-index';

/** Resolves an i18n key (or literal text) with a fallback. */
export type Translate = (key: string, defaultValue: string) => string;

export interface FilterPage {
  id: string;
  /** Label in the active language. */
  label: string;
  /** Label in English. */
  labelEn: string;
}

export interface FilterPageResult<P extends FilterPage = FilterPage> {
  page: P;
  /** The page name or the page's keywords matched the query. */
  pageMatched: boolean;
  /** Indexed elements of the page that matched, best match first. */
  elements: IndexedSetting[];
}

/** Normalizes a raw query; an empty string means "no filter". */
export function normalizeSettingsQuery(raw: string): string {
  return normalizeSearchText(raw.trim());
}

function includes(text: string | undefined, query: string): boolean {
  return !!text && normalizeSearchText(text).includes(query);
}

/**
 * How well an entry matches a normalized query: 0 = title, 1 = description or
 * keyword, -1 = no match. Compares the active language and English.
 */
export function matchSettingEntry(
  entry: SettingsIndexEntry,
  query: string,
  t: Translate,
  tEn: Translate,
): number {
  if (!query) return -1;
  const titleDefault = entry.titleDefault ?? entry.title;
  if (
    includes(t(entry.title, titleDefault), query) ||
    includes(tEn(entry.title, titleDefault), query)
  )
    return 0;
  if (entry.description) {
    const descDefault = entry.descriptionDefault ?? entry.description;
    if (
      includes(t(entry.description, descDefault), query) ||
      includes(tEn(entry.description, descDefault), query)
    )
      return 1;
  }
  if (entry.keywords?.some((k) => includes(k, query))) return 1;
  return -1;
}

function pageMatches(scope: SettingsScope, page: FilterPage, query: string): boolean {
  if (includes(page.label, query) || includes(page.labelEn, query) || includes(page.id, query))
    return true;
  return (SETTINGS_PAGE_KEYWORDS[scope][page.id] ?? []).some((k) => includes(k, query));
}

/**
 * Filters the pages a user can see (`pages`, already gated and in sidebar
 * order) by a normalized query. Entries of pages not in `pages` are never
 * returned, so the visibility rules stay with the builders of `pages`.
 */
export function filterSettings<P extends FilterPage>({
  scope,
  pages,
  query,
  t,
  tEn,
  entries = SETTINGS_INDEX,
}: {
  scope: SettingsScope;
  pages: readonly P[];
  query: string;
  t: Translate;
  tEn: Translate;
  entries?: readonly IndexedSetting[];
}): FilterPageResult<P>[] {
  if (!query) return [];
  const results: FilterPageResult<P>[] = [];
  for (const page of pages) {
    const ranked: Array<{ entry: IndexedSetting; rank: number; order: number }> = [];
    entries.forEach((entry, order) => {
      if (entry.scope !== scope || entry.page !== page.id) return;
      const rank = matchSettingEntry(entry, query, t, tEn);
      if (rank >= 0) ranked.push({ entry, rank, order });
    });
    ranked.sort((a, b) => a.rank - b.rank || a.order - b.order);
    const pageMatched = pageMatches(scope, page, query);
    if (!pageMatched && ranked.length === 0) continue;
    results.push({ page, pageMatched, elements: ranked.map((r) => r.entry) });
  }
  return results;
}

/** Number of results (pages that matched on their own plus elements). */
export function countSettingsResults(results: readonly FilterPageResult[]): number {
  return results.reduce(
    (n, r) => n + r.elements.length + (r.pageMatched && r.elements.length === 0 ? 1 : 0),
    0,
  );
}
