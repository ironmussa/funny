import type { ChangedFilesSummaryEventData, FileDiffSummary, ThreadEvent } from '@funny/shared';

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
 * the end). If a session somehow has more than one event, the last one wins.
 */
export function sessionChangesFromEvents(
  threadEvents: ThreadEvent[] | undefined,
): Map<string, FileDiffSummary[]> {
  const map = new Map<string, FileDiffSummary[]>();
  if (!threadEvents) return map;
  for (const e of threadEvents) {
    if (e.type !== 'changed_files_summary') continue;
    let parsed: ChangedFilesSummaryEventData | null = null;
    try {
      parsed = typeof e.data === 'string' ? JSON.parse(e.data) : (e.data as any);
    } catch {
      parsed = null;
    }
    if (!parsed?.userMessageId || !Array.isArray(parsed.files)) continue;
    map.set(parsed.userMessageId, parsed.files);
  }
  return map;
}
