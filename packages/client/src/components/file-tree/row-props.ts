import type { RefObject } from 'react';

export const INDENT_PX = 12;

/** Display settings and handlers every FileTree row shares. */
export interface FileTreeRowCommon {
  fontSize: string;
  hoverClass: string;
  testIdPrefix: string;
  searchQuery?: string;
  hideStatus: boolean;
  hideDiffStats: boolean;
  diffStatsSize: 'sm' | 'xs' | 'xxs';
  basePath?: string;
  /** Time the last row menu closed, so the click that closed it does not open the file. */
  dropdownCloseRef: RefObject<number>;
  onCopyPath: (path: string, relative: boolean) => void;
  onOpenDirectory: (relativePath: string, isFile: boolean) => Promise<void>;
}
