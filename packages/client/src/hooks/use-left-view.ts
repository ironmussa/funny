import { createContext, useCallback, useContext, useMemo } from 'react';
import { useLocation } from 'react-router-dom';

import { leftViewOf, withLeftView, type LeftViewColumn, type LeftViewState } from '@/lib/left-view';

/** The left view the URL names (see `lib/left-view.ts`). */
export function useLeftView(): LeftViewState {
  const { pathname, search } = useLocation();
  return useMemo(() => leftViewOf(pathname, search), [pathname, search]);
}

/**
 * The left view a component is drawn in (the board, the queue or the inbox),
 * set by the app shell around each of them. Null anywhere else.
 */
export const LeftViewScope = createContext<LeftViewColumn | null>(null);

/**
 * Makes the path of a thread opened from a left view keep that view beside it
 * (`?left=<view>`). Outside a left view the path is returned unchanged, so the
 * thread opens with the thread list.
 */
export function useLeftViewPath(): (path: string) => string {
  const view = useContext(LeftViewScope);
  return useCallback((path) => (view ? withLeftView(path, view) : path), [view]);
}
