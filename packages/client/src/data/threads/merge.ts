import type { Thread } from '@funny/shared';

/**
 * Rules for merging a thread row that arrives from a list or detail
 * response into the row the client already holds.
 */

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'stopped', 'interrupted']);
const ACTIVE_STATUSES = new Set(['setting_up', 'pending', 'running', 'waiting']);

function timeValue(value: string | undefined): number {
  if (!value) return 0;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

/** True when `next` ends the run `prev` was in (an active status became terminal). */
export function endsRun(prev: Thread, next: Thread): boolean {
  return TERMINAL_STATUSES.has(next.status) && !TERMINAL_STATUSES.has(prev.status);
}

/**
 * Per-field write fences (spec: *Optimistic writes never revert on stale data*).
 *
 * When a user write is confirmed, its fields are fenced at the layer's
 * current sequence number. A response whose request started BEFORE that
 * sequence cannot know about the write, so its values for those fields are
 * dropped. Its other fields still apply, so a concurrent status change still
 * lands. The first response that started after the fence proves the server
 * has the write, and clears the fence. No timer is involved.
 */
export type FieldFences = Map<string, Map<keyof Thread, number>>;

export function fenceFields(
  fences: FieldFences,
  threadId: string,
  fields: Iterable<keyof Thread>,
  seq: number,
): void {
  let byField = fences.get(threadId);
  if (!byField) {
    byField = new Map();
    fences.set(threadId, byField);
  }
  for (const field of fields) byField.set(field, seq);
}

/**
 * Fields of `threadId` an incoming row started at `startedSeq` must not
 * overwrite. Clears the fences the incoming row proves are confirmed.
 */
export function takeFencedFields(
  fences: FieldFences,
  threadId: string,
  startedSeq: number,
): Set<keyof Thread> {
  const fenced = new Set<keyof Thread>();
  const byField = fences.get(threadId);
  if (!byField) return fenced;
  for (const [field, seq] of byField) {
    if (startedSeq < seq) fenced.add(field);
    else byField.delete(field);
  }
  if (byField.size === 0) fences.delete(threadId);
  return fenced;
}

function shallowEqual(a: Thread, b: Thread): boolean {
  if (a === b) return true;
  // SAFETY: the keys come from Object.keys(a), and a is a Thread.
  const aKeys = Object.keys(a) as (keyof Thread)[];
  if (aKeys.length !== Object.keys(b).length) return false;
  return aKeys.every((key) => Object.is(a[key], b[key]));
}

/**
 * Merge an incoming server row into the held synced row.
 * Returns `prev` (same reference) when nothing visible changes, so
 * unchanged rows keep their identity across refreshes.
 */
export function mergeIncomingThread(
  prev: Thread | undefined,
  incoming: Thread,
  fenced: ReadonlySet<keyof Thread> = new Set(),
  startedBeforeRunEnded = false,
): Thread {
  if (!prev) return incoming;

  // WS result/status events are the freshest signal that a run ended. A list
  // request that started earlier can resolve later with the old active row and
  // make Activity show a permanent spinner again. Keep the terminal row unless
  // the incoming active row proves it is newer (a follow-up run started
  // elsewhere). Two clock-free proofs of staleness:
  //  - the request started before the realtime event that ended the run
  //    (`startedBeforeRunEnded`, from the data layer's request sequence);
  //  - its server `updatedAt` is not after the held row's server `updatedAt`.
  // The client never writes `updatedAt`, so both timestamps come from the
  // server clock: a skewed client clock cannot discard a newer row.
  if (
    TERMINAL_STATUSES.has(prev.status) &&
    ACTIVE_STATUSES.has(incoming.status) &&
    (startedBeforeRunEnded || timeValue(incoming.updatedAt) <= timeValue(prev.updatedAt))
  ) {
    return prev;
  }

  let next = incoming;
  if (fenced.size > 0) {
    const kept = Object.fromEntries([...fenced].map((field) => [field, prev[field]]));
    // SAFETY: each kept[field] is prev[field] for a keyof Thread field, so the
    // spread overwrites Thread fields with values of their own Thread type.
    next = { ...incoming, ...kept } as Thread;
  }
  return shallowEqual(prev, next) ? prev : next;
}
