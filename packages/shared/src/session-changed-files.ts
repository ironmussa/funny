import type { FileDiffSummary } from './types/git.js';

/**
 * Per-session "changed files" attribution — shared by the runtime (which
 * snapshots a session's summary when the agent run completes) and the client
 * (which reads the persisted snapshot back).
 *
 * The file LIST is derived from a session's file-mutating tool calls
 * (Write/Edit/MultiEdit/NotebookEdit) — the same rows that back the tool cards
 * — so it survives a page refresh even without a live working-tree diff. The
 * working-tree diff, when available, is matched in to supply +/- stats and
 * staged flags. Because the runtime snapshots this at session end and persists
 * it as a `changed_files_summary` thread event, the client never recomputes the
 * stats from the live working tree — the summary is a frozen record of what
 * that session changed.
 */

/** Tool calls that write to a file path, used to attribute changes to a session. */
export const FILE_MUTATING_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/** The persisted payload of a `changed_files_summary` thread event. */
export interface ChangedFilesSummaryEventData {
  /** The user-message id that opened the session this summary belongs to. */
  userMessageId: string;
  /** The files the session modified, frozen with their session-end +/- stats. */
  files: FileDiffSummary[];
}

/** Extract the file path a file-mutating tool call targeted, or null. */
export function toolCallFilePath(tc: any): string | null {
  if (!tc || !FILE_MUTATING_TOOLS.has(tc.name)) return null;
  let input: any = tc.input;
  if (typeof input === 'string') {
    try {
      input = JSON.parse(input);
    } catch {
      return null;
    }
  }
  const p = input?.file_path ?? input?.notebook_path;
  return typeof p === 'string' && p ? p : null;
}

/** Turn an absolute tool-call path into a repo-root-relative display path. */
export function relativizePath(abs: string, basePath?: string): string {
  if (basePath && (abs === basePath || abs.startsWith(`${basePath}/`))) {
    return abs.slice(basePath.length + 1);
  }
  return abs;
}

/**
 * Partition the files a thread modified into per-session buckets, keyed by the
 * user-message id that opened each session (turn).
 *
 * Stats come from the supplied working-tree diff when available; a file whose
 * changes are no longer in the working tree (committed/reverted) still appears,
 * just without line stats.
 */
export function collectSessionChanges(
  messages: any[],
  changedFiles: FileDiffSummary[],
  basePath?: string,
): Map<string, FileDiffSummary[]> {
  const result = new Map<string, FileDiffSummary[]>();

  // touched ABSOLUTE paths per user turn (order-preserving, deduped)
  const touchedByTurn = new Map<string, string[]>();
  let currentUserId: string | null = null;
  for (const msg of messages) {
    if (msg.role === 'user') {
      currentUserId = String(msg.id);
      if (!touchedByTurn.has(currentUserId)) touchedByTurn.set(currentUserId, []);
    }
    if (!currentUserId) continue;
    const list = touchedByTurn.get(currentUserId)!;
    for (const tc of msg.toolCalls ?? []) {
      const p = toolCallFilePath(tc);
      if (p && !list.includes(p)) list.push(p);
    }
  }

  // Resolve a touched absolute path to a FileDiffSummary: prefer the working-tree
  // diff entry (carries +/- stats); otherwise synthesize a stat-less entry from
  // the path so the file still appears. Tool-call paths are absolute; diff
  // summary paths are repo-root-relative.
  const resolve = (abs: string): FileDiffSummary => {
    const hit = changedFiles.find((f) => f.path === abs || abs.endsWith(`/${f.path}`));
    if (hit) return hit;
    return { path: relativizePath(abs, basePath), status: 'modified', staged: false };
  };

  for (const [uid, touched] of touchedByTurn) {
    if (touched.length === 0) continue;
    const seen = new Set<string>();
    const files: FileDiffSummary[] = [];
    for (const abs of touched) {
      const summary = resolve(abs);
      if (seen.has(summary.path)) continue;
      seen.add(summary.path);
      files.push(summary);
    }
    if (files.length > 0) result.set(uid, files);
  }
  return result;
}

/**
 * Compute the changed-files summary for the LATEST session only — the session
 * (user turn) that the just-completed agent run belongs to. Returns null when
 * that session touched no files. Used by the runtime to snapshot one summary
 * per completed session.
 */
export function latestSessionChanges(
  messages: any[],
  changedFiles: FileDiffSummary[],
  basePath?: string,
): ChangedFilesSummaryEventData | null {
  const all = collectSessionChanges(messages, changedFiles, basePath);
  if (all.size === 0) return null;
  // The last user turn in document order is the session that just completed.
  let lastUserMessageId: string | null = null;
  for (const msg of messages) {
    if (msg.role === 'user') lastUserMessageId = String(msg.id);
  }
  if (!lastUserMessageId) return null;
  const files = all.get(lastUserMessageId);
  if (!files || files.length === 0) return null;
  return { userMessageId: lastUserMessageId, files };
}
