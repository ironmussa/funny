import type { ThreadEvent, TurnOutcomeEventData } from '@funny/shared';

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

/**
 * How each user turn's run ended, keyed by user-message id, from persisted
 * `turn_outcome` thread events. Turns without an event (older threads, or the
 * run still in progress) are absent; if a turn has several events the last wins.
 */
export function turnOutcomesFromEvents(
  threadEvents: ThreadEvent[] | undefined,
): Map<string, TurnOutcomeEventData> {
  const map = new Map<string, TurnOutcomeEventData>();
  for (const e of threadEvents ?? []) {
    if (e.type !== 'turn_outcome') continue;
    let parsed: TurnOutcomeEventData | null = null;
    try {
      parsed = isString(e.data) ? JSON.parse(e.data) : e.data;
    } catch {
      parsed = null;
    }
    if (parsed?.userMessageId && parsed.status) map.set(parsed.userMessageId, parsed);
  }
  return map;
}
