export type {
  ConflictBlock,
  ConflictRole,
  DiffLine,
  DiffSection,
  ParsedDiff,
  SplitPair,
  ThreePaneTriple,
  VirtualRow,
} from '@/lib/diff-math';

import type { ConflictBlock, DiffLine, SplitPair, ThreePaneTriple } from '@/lib/diff-math';

export type RenderRow =
  | { type: 'unified-line'; line: DiffLine; lineIdx: number }
  | { type: 'split-pair'; pair: SplitPair }
  | { type: 'three-pane-triple'; triple: ThreePaneTriple }
  | { type: 'fold'; sectionIdx: number; lineCount: number; oldStart: number; newStart: number }
  | { type: 'hunk'; text: string; hunkStartIdx?: number }
  | { type: 'conflict-actions'; block: ConflictBlock };

export type DiffViewMode = 'unified' | 'split' | 'three-pane';

export type ConflictResolution = 'ours' | 'theirs' | 'both';

export interface VirtualDiffProps {
  /** Raw unified diff string (from gitoxide or git diff) */
  unifiedDiff: string;
  /** @deprecated Use `viewMode` instead. Split view (two columns) or unified (one column). Default: false */
  splitView?: boolean;
  /** View mode: 'unified' (1 col), 'split' (2 cols), or 'three-pane' (3 cols). Overrides splitView. */
  viewMode?: DiffViewMode;
  /** File path for syntax highlighting language detection */
  filePath?: string;
  /** Enable code folding for context sections. Default: true */
  codeFolding?: boolean;
  /** Lines of context around each change (default 3) */
  contextLines?: number;
  /** Show a minimap bar on the right with change indicators. Default: false */
  showMinimap?: boolean;
  /** Enable word wrap for long lines (uses pretext for height measurement). Default: false */
  wordWrap?: boolean;
  /** Search query to highlight in diff content */
  searchQuery?: string;
  /** Whether the search should be case-sensitive. Default: false */
  searchCaseSensitive?: boolean;
  /** Index of the current active match (0-based) for "current match" styling */
  currentMatchIndex?: number;
  /** Callback reporting total match count when searchQuery changes */
  onMatchCount?: (count: number) => void;
  /** Callback when user resolves a conflict block. blockId is 0-based index of the conflict. */
  onResolveConflict?: (blockId: number, resolution: ConflictResolution) => void;
  /** Enable line-level selection checkboxes (GitHub Desktop-style). Default: false */
  selectable?: boolean;
  /** Set of selected line indices (from the parsed diff's flat line array). Only meaningful when selectable=true. */
  selectedLines?: Set<number>;
  /** Called when user toggles a single line's checkbox. lineIdx is the index in the parsed lines array. */
  onLineToggle?: (lineIdx: number) => void;
  /** Called when user toggles a hunk header checkbox. Receives the start/end line indices of the hunk. */
  onHunkToggle?: (hunkLineIndices: number[]) => void;
  /** Called during drag-select with the range of line indices (start, current) and mode (select/deselect). */
  onDragSelect?: (startLineIdx: number, endLineIdx: number, select: boolean) => void;
  className?: string;
  'data-testid'?: string;
}
