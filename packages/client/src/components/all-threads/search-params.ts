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

/** Build search params from current filter state (preserves status/sort params if present) */
export function buildAllThreadsSearchParams(
  searchParams: URLSearchParams,
  { projectFilter, search, caseSensitive }: CurrentFilters,
  overrides?: SearchParamOverrides,
) {
  const params: Record<string, string> = {};
  const proj = overrides?.project !== undefined ? overrides.project : projectFilter;
  if (proj) params.project = proj;
  // Text search lives in the URL so back-navigation from a thread (and
  // browser back/forward) restores the query.
  const q = overrides?.search !== undefined ? overrides.search : search;
  if (q.trim()) params.search = q;
  const cs = overrides?.cs !== undefined ? overrides.cs : caseSensitive;
  if (cs) params.cs = '1';
  const statusParam = searchParams.get('status');
  if (statusParam) params.status = statusParam;
  const sortParam = searchParams.get('sort');
  if (sortParam) params.sort = sortParam;
  const dirParam = searchParams.get('dir');
  if (dirParam) params.dir = dirParam;
  const scratchParam = searchParams.get('scratch');
  if (scratchParam) params.scratch = scratchParam;
  const returnThreadParam = searchParams.get('returnThread');
  if (returnThreadParam && proj === projectFilter) params.returnThread = returnThreadParam;
  return params;
}
