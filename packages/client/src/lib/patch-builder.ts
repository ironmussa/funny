/**
 * Build a valid unified-diff patch from a raw diff string and a set of selected line indices.
 *
 * This is used for partial (line-level) staging à la GitHub Desktop:
 * the user selects individual add/del lines, and we construct a patch
 * that `git apply --cached` can consume.
 *
 * Selected lines = lines the user wants to stage.
 * Non-selected add lines become context (removed from patch).
 * Non-selected del lines become context (kept as-is in patch).
 */

export interface ParsedDiffLine {
  /** Index within the flat parsed array (used as selection key) */
  index: number;
  type: 'add' | 'del' | 'ctx' | 'hunk-header';
  text: string;
  /** Original raw line from the diff (with +/- prefix) */
  raw: string;
  /** Which hunk (0-based) this line belongs to */
  hunkIndex: number;
}

export interface ParsedHunk {
  /** The full @@ ... @@ header line */
  header: string;
  lines: ParsedDiffLine[];
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
}

export interface ParsedFileDiff {
  /** The raw header lines (diff --git, index, ---, +++) */
  headerLines: string[];
  hunks: ParsedHunk[];
  allLines: ParsedDiffLine[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parse a raw unified diff into structured hunks and lines.
 */
export function parseRawDiff(rawDiff: string): ParsedFileDiff {
  const lines = rawDiff.split('\n');
  const headerLines: string[] = [];
  const hunks: ParsedHunk[] = [];
  const allLines: ParsedDiffLine[] = [];
  let lineIdx = 0;
  let currentHunk: ParsedHunk | null = null;
  let hunkIndex = -1;
  let inHeader = true;

  for (const line of lines) {
    const hunkMatch = HUNK_RE.exec(line);

    if (hunkMatch) {
      inHeader = false;
      hunkIndex++;
      currentHunk = {
        header: line,
        lines: [],
        oldStart: parseInt(hunkMatch[1], 10),
        oldCount: hunkMatch[2] != null ? parseInt(hunkMatch[2], 10) : 1,
        newStart: parseInt(hunkMatch[3], 10),
        newCount: hunkMatch[4] != null ? parseInt(hunkMatch[4], 10) : 1,
      };
      hunks.push(currentHunk);
      continue;
    }

    if (inHeader) {
      headerLines.push(line);
      continue;
    }

    if (!currentHunk) continue;

    // Skip "\ No newline at end of file"
    if (line.startsWith('\\')) continue;

    let type: ParsedDiffLine['type'];
    let text: string;

    if (line.startsWith('+')) {
      type = 'add';
      text = line.substring(1);
    } else if (line.startsWith('-')) {
      type = 'del';
      text = line.substring(1);
    } else {
      type = 'ctx';
      text = line.length > 0 && line[0] === ' ' ? line.substring(1) : line;
    }

    const parsed: ParsedDiffLine = {
      index: lineIdx++,
      type,
      text,
      raw: line,
      hunkIndex,
    };

    currentHunk.lines.push(parsed);
    allLines.push(parsed);
  }

  return { headerLines, hunks, allLines };
}

/**
 * Build a patch string from the parsed diff, including only selected lines.
 *
 * @param parsed - The parsed file diff
 * @param selectedIndices - Set of line indices that are "selected" (to be staged)
 *
 * For non-selected add lines: they are simply omitted from the patch.
 * For non-selected del lines: they become context lines (the line stays in the file).
 */
export function buildPatchFromSelection(
  parsed: ParsedFileDiff,
  selectedIndices: Set<number>,
): string {
  const outputLines: string[] = [...parsed.headerLines];

  for (const hunk of parsed.hunks) {
    const patchLines: string[] = [];
    let oldCount = 0;
    let newCount = 0;

    for (const line of hunk.lines) {
      const isSelected = selectedIndices.has(line.index);

      if (line.type === 'ctx') {
        // Context lines always included
        patchLines.push(' ' + line.text);
        oldCount++;
        newCount++;
      } else if (line.type === 'del') {
        if (isSelected) {
          // Selected deletion: include as deletion
          patchLines.push('-' + line.text);
          oldCount++;
        } else {
          // Not selected: becomes context (line stays)
          patchLines.push(' ' + line.text);
          oldCount++;
          newCount++;
        }
      } else if (line.type === 'add') {
        if (isSelected) {
          // Selected addition: include as addition
          patchLines.push('+' + line.text);
          newCount++;
        }
        // Not selected: omit entirely (line not added to index)
      }
    }

    // Skip hunks with no actual changes
    const hasChanges = patchLines.some((l) => l.startsWith('+') || l.startsWith('-'));
    if (!hasChanges) continue;

    // Rebuild hunk header with corrected counts
    const hunkHeaderMatch = HUNK_RE.exec(hunk.header);
    if (!hunkHeaderMatch) continue;

    const rest = hunk.header.substring(hunkHeaderMatch[0].length);
    const newHeader = `@@ -${hunk.oldStart},${oldCount} +${hunk.newStart},${newCount} @@${rest}`;

    outputLines.push(newHeader);
    outputLines.push(...patchLines);
  }

  // If no hunks produced changes, return empty
  if (outputLines.length === parsed.headerLines.length) return '';

  return outputLines.join('\n') + '\n';
}

/**
 * Get all changeable (add/del) line indices from a parsed diff.
 */
export function getChangeableIndices(parsed: ParsedFileDiff): Set<number> {
  const indices = new Set<number>();
  for (const line of parsed.allLines) {
    if (line.type === 'add' || line.type === 'del') {
      indices.add(line.index);
    }
  }
  return indices;
}

/**
 * Get all changeable line indices within a specific hunk.
 */
export function getHunkChangeableIndices(parsed: ParsedFileDiff, hunkIndex: number): Set<number> {
  const indices = new Set<number>();
  const hunk = parsed.hunks[hunkIndex];
  if (!hunk) return indices;
  for (const line of hunk.lines) {
    if (line.type === 'add' || line.type === 'del') {
      indices.add(line.index);
    }
  }
  return indices;
}
