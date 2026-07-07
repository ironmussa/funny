import type { BlameHunk, BlameResponse, FileHistoryEntry } from '@/lib/api/system';

export interface BlameHistoryLineRange {
  startLine: number;
  endLine: number;
}

export interface BlameHistoryEntry {
  commitHash: string;
  shortHash: string;
  author: string;
  relativeDate: string;
  summary: string;
  lineCount: number;
  ranges: BlameHistoryLineRange[];
  uncommitted: boolean;
  status?: FileHistoryEntry['status'];
  path?: string;
  previousPath?: string | null;
}

const UNCOMMITTED_KEY = '__working_tree__';

export function buildBlameHistoryEntries(
  blame: BlameResponse,
  content: string,
): BlameHistoryEntry[] {
  const entriesByCommit = new Map<string, BlameHistoryEntry>();

  for (const hunk of blame.hunks) {
    const entry = entriesByCommit.get(hunk.commitHash);
    if (entry) {
      entry.lineCount += hunk.lineCount;
      entry.ranges.push(toRange(hunk));
      continue;
    }

    entriesByCommit.set(hunk.commitHash, {
      commitHash: hunk.commitHash,
      shortHash: hunk.shortHash,
      author: hunk.author,
      relativeDate: hunk.relativeDate,
      summary: hunk.summary,
      lineCount: hunk.lineCount,
      ranges: [toRange(hunk)],
      uncommitted: false,
    });
  }

  const workingTreeLines = countWorkingTreeLines(content);
  if (workingTreeLines > blame.blamedLineCount) {
    const startLine = blame.blamedLineCount + 1;
    entriesByCommit.set(UNCOMMITTED_KEY, {
      commitHash: UNCOMMITTED_KEY,
      shortHash: 'worktree',
      author: 'You',
      relativeDate: 'Uncommitted',
      summary: 'Uncommitted changes',
      lineCount: workingTreeLines - blame.blamedLineCount,
      ranges: [{ startLine, endLine: workingTreeLines }],
      uncommitted: true,
    });
  }

  return Array.from(entriesByCommit.values());
}

export function buildFileHistoryEntries({
  blame,
  fileHistory,
  content,
}: {
  blame: BlameResponse | null;
  fileHistory: FileHistoryEntry[];
  content: string;
}): BlameHistoryEntry[] {
  const blameEntries = blame ? buildBlameHistoryEntries(blame, content) : [];
  if (fileHistory.length === 0) return blameEntries;

  const blameByCommit = new Map(
    blameEntries.filter((entry) => !entry.uncommitted).map((entry) => [entry.commitHash, entry]),
  );
  const seen = new Set<string>();
  const entries = fileHistory.map((history) => {
    const blamed = blameByCommit.get(history.hash);
    seen.add(history.hash);
    return {
      commitHash: history.hash,
      shortHash: history.shortHash,
      author: history.author,
      relativeDate: history.relativeDate,
      summary: history.message,
      lineCount: blamed?.lineCount ?? 0,
      ranges: blamed?.ranges ?? [],
      uncommitted: false,
      status: history.status,
      path: history.path,
      previousPath: history.previousPath,
    } satisfies BlameHistoryEntry;
  });

  const blameOnlyEntries = blameEntries.filter(
    (entry) => entry.uncommitted || !seen.has(entry.commitHash),
  );
  return [
    ...blameOnlyEntries.filter((entry) => entry.uncommitted),
    ...entries,
    ...blameOnlyEntries.filter((entry) => !entry.uncommitted),
  ];
}

export function formatBlameLineRange(range: BlameHistoryLineRange): string {
  if (range.startLine === range.endLine) return `L${range.startLine}`;
  return `L${range.startLine}-L${range.endLine}`;
}

export function formatBlameLineRanges(ranges: BlameHistoryLineRange[], visibleCount = 3): string {
  const visible = ranges.slice(0, visibleCount).map(formatBlameLineRange);
  const hiddenCount = ranges.length - visible.length;
  if (hiddenCount <= 0) return visible.join(', ');
  return `${visible.join(', ')} +${hiddenCount}`;
}

function toRange(hunk: BlameHunk): BlameHistoryLineRange {
  return {
    startLine: hunk.startLine,
    endLine: hunk.startLine + hunk.lineCount - 1,
  };
}

function countWorkingTreeLines(content: string): number {
  if (content.length === 0) return 0;
  return content.split(/\r\n|\r|\n/).length;
}
