import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

/**
 * Tailwind swap classes keyed by the parent's hover group. They must be written
 * as literal strings so Tailwind's JIT scanner picks them up — building them
 * dynamically (e.g. `group-hover/${name}:opacity-0`) would NOT be emitted.
 *
 * Add a new entry here when a row uses a differently-named `group/<name>`.
 */
const SWAP = {
  /** Unnamed `group` on the parent row (the default). */
  default: {
    time: 'group-hover:opacity-0 group-hover:pointer-events-none',
    menu: 'group-hover:opacity-100',
  },
  /** Parent row carries `group/thread` (sidebar ThreadItem). */
  thread: {
    time: 'group-hover/thread:opacity-0 group-hover/thread:pointer-events-none',
    menu: 'group-hover/thread:opacity-100',
  },
} as const;

interface HoverTimeMenuProps {
  /** Resting content (typically a relative timestamp) shown when not hovered. */
  time: ReactNode;
  /** Extra classes for the resting time text. */
  timeClassName?: string;
  /** The menu element (kebab trigger + dropdown) revealed on hover. */
  children: ReactNode;
  /**
   * Force the menu visible (and the time hidden) regardless of hover — pass the
   * dropdown's open state so the swap doesn't flip back while the menu is open.
   */
  open?: boolean;
  /**
   * Which Tailwind hover group drives the swap. The parent row MUST carry the
   * matching `group` / `group/<name>` class. Defaults to the unnamed `group`.
   */
  group?: keyof typeof SWAP;
  /** Extra classes for the swap container (e.g. `min-w-10`). */
  className?: string;
}

/**
 * Time-↔-menu swap cell shared by the sidebar thread rows and the commit-graph
 * rows. Both the resting timestamp and the (hover-revealed) kebab menu occupy
 * the SAME grid cell (`col-start-1 row-start-1`), so the row reserves space for
 * one of them — not both — keeping dense rows compact. On hover the time fades
 * out and the menu fades in; while `open` is true the menu stays pinned.
 */
export function HoverTimeMenu({
  time,
  timeClassName,
  children,
  open = false,
  group = 'default',
  className,
}: HoverTimeMenuProps) {
  const swap = SWAP[group];
  return (
    <div className={cn('grid place-items-center justify-items-center', className)}>
      <span
        className={cn(
          'col-start-1 row-start-1',
          swap.time,
          timeClassName,
          open && 'pointer-events-none opacity-0',
        )}
      >
        {time}
      </span>
      <div
        className={cn(
          'col-start-1 row-start-1 flex items-center opacity-0',
          swap.menu,
          open && 'opacity-100!',
        )}
      >
        {children}
      </div>
    </div>
  );
}
