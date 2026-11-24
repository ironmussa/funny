import type { ChangedFilesSummaryEventData, FileDiffSummary, ThreadEvent } from '@funny/shared';

/** One session's frozen changed-files snapshot and when it was taken. */
export interface SessionChanges {
  files: FileDiffSummary[];
  /** When the run that produced the snapshot ended (the event's `createdAt`). */
  createdAt: string;
}

/**
 * Build the per-session changed-files map the in-chat summary renders from,
 * keyed by the session's user-message id, out of persisted
 * `changed_files_summary` thread events.
 *
 * This is the read side of the frozen snapshot the runtime writes when an agent
 * run completes. The summary is NOT recomputed from the live working tree on
 * every render/refresh — it is replayed verbatim from these events, so it shows
 * exactly what the session changed at the moment it finished. A session in
 * progress has no event yet, so it renders no card (the summary appears only at
 * the end). A session can have more than one event: a background job or a
 * watcher wakes the agent without a new user message, so the woken run belongs
 * to the same session. The last event wins, and its `createdAt` places the card
 * among the session's items.
 */
export function sessionChangesFromEvents(
  threadEvents: ThreadEvent[] | undefined,
): Map<string, SessionChanges> {
  const map = new Map<string, SessionChanges>();
  if (!threadEvents) return map;
  for (const e of threadEvents) {
    if (e.type !== 'changed_files_summary') continue;
    let parsed: ChangedFilesSummaryEventData | null = null;
    try {
      parsed = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
    } catch {
      parsed = null;
    }
    if (!parsed?.userMessageId || !Array.isArray(parsed.files)) continue;
    map.set(parsed.userMessageId, { files: parsed.files, createdAt: e.createdAt ?? '' });
  }
  return map;
}
