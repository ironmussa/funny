import type { ReactNode } from 'react';

/** A single tab inside the right-pane group (fixed set — not closeable). */
export type RightTabSpec = {
  id: string;
  title: string;
  content: ReactNode;
};

/** A single tab inside the bottom group (e.g. one terminal). User-closeable
 *  via dockview's native tab X. */
export type BottomTabSpec = {
  id: string;
  title: string;
  content: ReactNode;
};
