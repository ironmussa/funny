interface FileResult {
  path: string;
  matches: Array<{ line: number; text: string; ranges: Array<{ start: number; end: number }> }>;
}

/** Answer of the text search endpoint. */
export interface SearchResponse {
  files: FileResult[];
  totalMatches: number;
  truncated: boolean;
  durationMs: number;
  basePath: string;
}

/**
 * Flattened item used by the virtualized list — one entry per visible row
 * (file header OR a single match line). Lets the list keep a constant row
 * height and supports keyboard navigation across files without nested loops.
 */
export type FlatRow =
  | { kind: 'file'; fileIndex: number; path: string; matchCount: number; collapsed: boolean }
  | {
      kind: 'match';
      fileIndex: number;
      matchIndex: number;
      path: string;
      line: number;
      text: string;
      ranges: Array<{ start: number; end: number }>;
    };

/** One header row per file, followed by its match rows unless the file is collapsed. */
export function buildFlatRows(
  response: SearchResponse | null,
  collapsed: Record<string, boolean>,
): FlatRow[] {
  if (!response) return [];
  const rows: FlatRow[] = [];
  response.files.forEach((file, fileIndex) => {
    const isCollapsed = collapsed[file.path] === true;
    rows.push({
      kind: 'file',
      fileIndex,
      path: file.path,
      matchCount: file.matches.length,
      collapsed: isCollapsed,
    });
    if (isCollapsed) return;
    file.matches.forEach((m, matchIndex) => {
      rows.push({
        kind: 'match',
        fileIndex,
        matchIndex,
        path: file.path,
        line: m.line,
        text: m.text,
        ranges: m.ranges,
      });
    });
  });
  return rows;
}
