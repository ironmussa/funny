import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const TOAST_DURATION = 5000;

/**
 * Icon size tokens — mirrors the `icon-*` CSS utilities in globals.css.
 * Named after the Tailwind text-* scale so you can pair icon-sm with text-sm.
 *
 * Use these when a component needs to pick an icon size programmatically
 * (e.g. mapping a button size prop to an icon class).
 */
export const ICON_SIZE = {
  '2xs': 'icon-2xs', // 10px
  xs: 'icon-xs', // 12px
  sm: 'icon-sm', // 14px
  base: 'icon-base', // 16px
  lg: 'icon-lg', // 20px
  xl: 'icon-xl', // 24px
} as const;

export type IconSize = keyof typeof ICON_SIZE;

/**
 * Derive the git branch name from a worktree path.
 * Worktree folder: `<projectSlug>-<titleSlug>-<id6>` (hyphens)
 * Git branch:      `<projectSlug>/<titleSlug>-<id6>` (first hyphen → slash)
 */
export function deriveBranchFromWorktreePath(worktreePath: string): string {
  const folder = worktreePath.split('/').pop() ?? '';
  const idx = folder.indexOf('-');
  return idx >= 0 ? `${folder.substring(0, idx)}/${folder.substring(idx + 1)}` : folder;
}

/**
 * Resolve the effective branch for a thread.
 * Falls back to deriving from worktreePath when branch is missing.
 */
export function resolveThreadBranch(thread: {
  branch?: string | null;
  worktreePath?: string | null;
}): string | undefined {
  if (thread.branch) return thread.branch;
  if (thread.worktreePath) return deriveBranchFromWorktreePath(thread.worktreePath);
  return undefined;
}

/** Branch label for a local-mode thread (matches ThreadPowerline for local threads). */
export function resolveLocalThreadBranch(thread: {
  branch?: string | null;
  baseBranch?: string | null;
  worktreePath?: string | null;
}): string | undefined {
  return resolveThreadBranch(thread) ?? thread.baseBranch ?? undefined;
}

type ThreadBranchIdentity = {
  mode?: string;
  isScratch?: boolean;
  projectId?: string;
  branch?: string | null;
  baseBranch?: string | null;
  worktreePath?: string | null;
};

/**
 * Whether selecting `target` should run a project-level branch checkout.
 * Skips when both threads are local, same project, and share the same branch
 * (switching threads is UI-only — no git branch change needed).
 */
export function shouldCheckoutBranchForThreadSelect(
  target: ThreadBranchIdentity,
  active: ThreadBranchIdentity | null | undefined,
): boolean {
  if (target.isScratch || !target.projectId) return false;
  if (target.mode !== 'local') return false;
  const targetBranch = resolveLocalThreadBranch(target);
  if (!targetBranch) return false;
  if (!active || active.mode !== 'local' || active.projectId !== target.projectId) return true;
  return resolveLocalThreadBranch(active) !== targetBranch;
}

/**
 * Top inset used when scrolling sidebar items into view, so the row doesn't
 * end up flush against the top of the scroll container. Includes a few pixels
 * of breathing room.
 */
export const SIDEBAR_SCROLL_TOP_OFFSET = 16;

/**
 * Scroll a sidebar row into view inside its scroll container, keeping it
 * clear of the top edge. Mimics native `scrollIntoView`
 * `block: 'start' | 'nearest'` semantics but applies a top offset.
 */
export function scrollSidebarItemIntoView(
  root: HTMLElement,
  el: Element,
  block: 'start' | 'nearest' = 'nearest',
  offset = SIDEBAR_SCROLL_TOP_OFFSET,
): void {
  const elRect = el.getBoundingClientRect();
  const rootRect = root.getBoundingClientRect();
  const elTopRel = elRect.top - rootRect.top;
  const elBottomRel = elRect.bottom - rootRect.top;

  if (block === 'start') {
    const targetTop = root.scrollTop + elTopRel - offset;
    root.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' });
    return;
  }

  if (elTopRel < offset) {
    const targetTop = root.scrollTop + elTopRel - offset;
    root.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' });
  } else if (elBottomRel > root.clientHeight) {
    const targetTop = root.scrollTop + (elBottomRel - root.clientHeight);
    root.scrollTo({ top: targetTop, behavior: 'smooth' });
  }
}
