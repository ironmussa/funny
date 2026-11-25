/**
 * The search view's filters as URL query params, so leaving the view (opening
 * a thread, browser back) and coming back restores them.
 */

export type SortField = 'updated' | 'created';
export type SortDir = 'desc' | 'asc';

export interface ListFilters {
  status: Set<string>;
  git: Set<string>;
  mode: Set<string>;
  type: Set<string>;
  origin: Set<string>;
  showArchived: boolean;
  sortField: SortField;
  sortDir: SortDir;
}

const THREAD_ORIGINS = new Set(['factory', 'user']);

function parseList(param: string | null): Set<string> {
  return new Set((param ?? '').split(',').filter(Boolean));
}

/** `?origin=factory,user` as a filter set; unknown values are dropped. */
function parseOrigin(param: string | null): Set<string> {
  return new Set([...parseList(param)].filter((value) => THREAD_ORIGINS.has(value)));
}

/** `?type=scratch,normal`, or the older `?scratch=1` the sidebar links with. */
function parseType(params: URLSearchParams): Set<string> {
  const type = parseList(params.get('type'));
  if (params.get('scratch') === '1') type.add('scratch');
  return type;
}

/** Read every filter from the URL; a missing param is the filter's default. */
export function parseListFilters(params: URLSearchParams): ListFilters {
  const sort = params.get('sort');
  const dir = params.get('dir');
  return {
    status: parseList(params.get('status')),
    git: parseList(params.get('git')),
    mode: parseList(params.get('mode')),
    type: parseType(params),
    origin: parseOrigin(params.get('origin')),
    showArchived: params.get('archived') === '1',
    sortField: sort === 'created' ? 'created' : 'updated',
    sortDir: dir === 'asc' ? 'asc' : 'desc',
  };
}

function setList(params: URLSearchParams, key: string, values: Set<string>) {
  if (values.size > 0) params.set(key, [...values].join(','));
  else params.delete(key);
}

/**
 * `current` with the filter params replaced by `filters`. Every other param
 * (project, search, returnThread, highlight, …) is kept as is.
 */
export function writeListFilters(current: URLSearchParams, filters: ListFilters): URLSearchParams {
  const params = new URLSearchParams(current);
  setList(params, 'status', filters.status);
  setList(params, 'git', filters.git);
  setList(params, 'mode', filters.mode);
  setList(params, 'origin', filters.origin);
  // Only scratch: keep the short `?scratch=1` form the sidebar links with.
  const scratchOnly = filters.type.size === 1 && filters.type.has('scratch');
  if (scratchOnly) params.set('scratch', '1');
  else params.delete('scratch');
  setList(params, 'type', scratchOnly ? new Set() : filters.type);
  if (filters.showArchived) params.set('archived', '1');
  else params.delete('archived');
  if (filters.sortField !== 'updated') params.set('sort', filters.sortField);
  else params.delete('sort');
  if (filters.sortDir !== 'desc') params.set('dir', filters.sortDir);
  else params.delete('dir');
  return params;
}
