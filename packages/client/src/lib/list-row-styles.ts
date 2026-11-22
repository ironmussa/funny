/**
 * One look for the rows of the review pane's list tabs (Stash, Worktrees, PRs,
 * Issues, History): the same padding, text size and hover shade, and row
 * actions that appear only while the row is hovered or focused.
 */

/** A list row. `group` lets its actions reveal themselves on hover. */
export const listRowClassName =
  'group hover:bg-sidebar-accent/50 flex w-full items-start gap-2 px-3 py-2.5 text-xs transition-colors';

/** The row's title line: the same size as a commit title in History (`text-xs`). */
export const listRowTitleClassName = 'text-foreground text-xs leading-5 font-medium';

/**
 * A row action (ghost `icon-xs` button with an `icon-sm` icon): hidden until
 * hover or focus, kept while its menu is open. A disabled action stays hidden
 * too, and shows dimmed on hover: the Button's own `disabled:opacity-50`
 * would otherwise beat `opacity-0` and leave it on screen at all times.
 */
export const listRowActionClassName =
  'text-muted-foreground hover:text-foreground shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 disabled:opacity-0 group-hover:disabled:opacity-50';

/** Keeps a row action on screen while it works (its spinner), even though it is disabled meanwhile. */
export const listRowActionBusyClassName = 'opacity-100 disabled:opacity-100';
