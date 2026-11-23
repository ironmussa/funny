/**
 * The factory view's filters and layout, kept in its search parameters so a
 * filtered view can be linked, survives a reload and follows back / forward
 * (like the threads view's `?project=` / `?status=` / `?search=`):
 *
 * - `project` — project ids, comma separated
 * - `status` — run states, comma separated
 * - `search` / `cs=1` — the text filter and its case sensitivity
 * - `active=1` — only runs that have not ended
 * - `view=list|board` — the layout; without it the view uses the saved one
 *
 * Other parameters (the detail panel's `run`) are left as they are.
 */
import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';

import { type FactoryViewLayout, useFactoryViewStore } from '@/stores/factory-view-store';

export interface FactoryViewFilters {
  search: string;
  caseSensitive: boolean;
  states: Set<string>;
  projectIds: Set<string>;
  activeOnly: boolean;
  /** The layout the link names, or null when it names none. */
  layout: FactoryViewLayout | null;
}

export type FactoryViewPatch = Partial<FactoryViewFilters>;

function readList(params: URLSearchParams, key: string): Set<string> {
  return new Set((params.get(key) ?? '').split(',').filter(Boolean));
}

export function parseFactoryViewParams(params: URLSearchParams): FactoryViewFilters {
  const view = params.get('view');
  return {
    search: params.get('search') ?? '',
    caseSensitive: params.get('cs') === '1',
    states: readList(params, 'status'),
    projectIds: readList(params, 'project'),
    activeOnly: params.get('active') === '1',
    layout: view === 'list' || view === 'board' ? view : null,
  };
}

function writeValue(next: URLSearchParams, key: string, value: string | null) {
  if (value) next.set(key, value);
  else next.delete(key);
}

/** `current` with the patched filters written, empty ones removed. */
export function applyFactoryViewPatch(
  current: URLSearchParams,
  patch: FactoryViewPatch,
): URLSearchParams {
  const next = new URLSearchParams(current);
  if (patch.search !== undefined) writeValue(next, 'search', patch.search);
  if (patch.caseSensitive !== undefined) writeValue(next, 'cs', patch.caseSensitive ? '1' : null);
  if (patch.states !== undefined) writeValue(next, 'status', [...patch.states].join(','));
  if (patch.projectIds !== undefined) writeValue(next, 'project', [...patch.projectIds].join(','));
  if (patch.activeOnly !== undefined) writeValue(next, 'active', patch.activeOnly ? '1' : null);
  if (patch.layout !== undefined) writeValue(next, 'view', patch.layout);
  return next;
}

/**
 * The view's filters from the URL, and one `update` that writes several at
 * once (React Router does not queue updates, so two separate writes in one
 * handler would lose the first). The layout falls back to the saved one, and
 * choosing a layout also saves it for the next visit.
 */
export function useFactoryViewParams() {
  const [params, setParams] = useSearchParams();
  const savedLayout = useFactoryViewStore((state) => state.layout);
  const saveLayout = useFactoryViewStore((state) => state.setLayout);
  const filters = useMemo(() => parseFactoryViewParams(params), [params]);

  const update = useCallback(
    (patch: FactoryViewPatch) => {
      if (patch.layout) saveLayout(patch.layout);
      setParams((current) => applyFactoryViewPatch(current, patch), { replace: true });
    },
    [setParams, saveLayout],
  );

  return { filters, layout: filters.layout ?? savedLayout, update };
}
