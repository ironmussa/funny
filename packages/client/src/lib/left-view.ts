import { parseRoute } from '@/hooks/route-parser';

/**
 * What the left side of the window shows: the thread list, or the kanban
 * board, the factory queue or the automation inbox in its place.
 *
 * The URL alone decides it, so the back and forward buttons, a reload and a
 * copied link all show the same thing:
 *
 * - `/kanban`, `/factory`, `/inbox`: the view fills the window, with no thread.
 * - any other route with `?left=<view>`: the view is a column beside the thread.
 * - anything else: the thread list.
 *
 * Do not keep a copy of this in a store.
 */
export type LeftView = 'threads' | 'kanban' | 'factory' | 'inbox';

/** A left view that is not the thread list. */
export type LeftViewColumn = Exclude<LeftView, 'threads'>;

export interface LeftViewState {
  view: LeftView;
  /** The view takes the whole window (its own route), with no thread beside it. */
  fillsWindow: boolean;
}

/** The query parameter that names the view shown beside a thread. */
const LEFT_VIEW_PARAM = 'left';

/** The route on which each view fills the window. */
export const LEFT_VIEW_ROUTES: Record<LeftViewColumn, string> = {
  kanban: '/kanban',
  factory: '/factory',
  inbox: '/inbox',
};

const THREADS: LeftViewState = { view: 'threads', fillsWindow: false };

function isLeftViewColumn(value: string | null): value is LeftViewColumn {
  return value !== null && Object.hasOwn(LEFT_VIEW_ROUTES, value);
}

/** The left view of a location. */
export function leftViewOf(pathname: string, search: string): LeftViewState {
  const route = parseRoute(pathname);
  if (route.kanban) return { view: 'kanban', fillsWindow: true };
  if (route.factory) return { view: 'factory', fillsWindow: true };
  if (route.inbox) return { view: 'inbox', fillsWindow: true };
  const beside = new URLSearchParams(search).get(LEFT_VIEW_PARAM);
  return isLeftViewColumn(beside) ? { view: beside, fillsWindow: false } : THREADS;
}

/** `path` with `view` beside it (`?left=<view>`), or with the thread list (no parameter). */
export function withLeftView(path: string, view: LeftView | null): string {
  const queryAt = path.indexOf('?');
  const pathname = queryAt === -1 ? path : path.slice(0, queryAt);
  const params = new URLSearchParams(queryAt === -1 ? '' : path.slice(queryAt + 1));
  if (view && view !== 'threads') params.set(LEFT_VIEW_PARAM, view);
  else params.delete(LEFT_VIEW_PARAM);
  const search = params.toString();
  return search ? `${pathname}?${search}` : pathname;
}
