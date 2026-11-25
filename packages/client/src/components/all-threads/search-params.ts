export interface SearchParamOverrides {
  project?: string | null;
  search?: string;
  cs?: boolean;
}

interface CurrentFilters {
  projectFilter: string | null;
  search: string;
  caseSensitive: boolean;
}

/**
 * The current params with project / search / case overridden; every other
 * param (the filters, returnThread, highlight) is kept.
 */
export function buildAllThreadsSearchParams(
  searchParams: URLSearchParams,
  { projectFilter, search, caseSensitive }: CurrentFilters,
  overrides?: SearchParamOverrides,
): URLSearchParams {
  const params = new URLSearchParams(searchParams);
  const proj = overrides?.project !== undefined ? overrides.project : projectFilter;
  if (proj) params.set('project', proj);
  else params.delete('project');
  // Text search lives in the URL so back-navigation from a thread (and
  // browser back/forward) restores the query.
  const q = overrides?.search !== undefined ? overrides.search : search;
  if (q.trim()) params.set('search', q);
  else params.delete('search');
  const cs = overrides?.cs !== undefined ? overrides.cs : caseSensitive;
  if (cs) params.set('cs', '1');
  else params.delete('cs');
  if (proj !== projectFilter) params.delete('returnThread');
  return params;
}
