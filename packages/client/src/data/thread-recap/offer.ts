import {
  DEFAULT_THREAD_RECAP_MIN_ABSENCE_MINUTES,
  type ProfileResponse,
} from '@funny/shared/contracts/profile';

import { canShowRecap, shouldOfferRecap } from '@/lib/thread-variant';

import type { ThreadRecapRequest } from './api';
import { isUtilityModelUnavailable } from './queries';

/**
 * The pure decisions behind the recap card (openspec `thread-recap`): whether
 * an open offers a recap, and what a recap query's state shows.
 */

/** The thread's open snapshot (`stores/thread-read-store.ts` `ThreadOpenSnapshot`). */
export interface RecapOpen {
  readAt: string | null;
  openedAt: number;
  createdAt: string | null;
  newestMessageId: string | null;
  newestActivityAt: string | null;
}

export interface RecapThread {
  id: string;
  userId: string;
  createdAt: string;
  runtime?: string | null;
}

/**
 * What the card shows. `key` is `threadId:newestMessageId`, the unit a
 * dismissal hides.
 */
export type ThreadRecapView =
  | { state: 'hidden' }
  | { state: 'loading'; key: string }
  | { state: 'ready'; key: string; recap: string }
  | { state: 'unavailable'; key: string };

export const HIDDEN_RECAP: ThreadRecapView = { state: 'hidden' };

export interface RecapOffer {
  key: string;
  body: Omit<ThreadRecapRequest, 'language'>;
}

/**
 * The recap an open offers, or null: recaps on in the profile, a viewer who
 * may see one, and activity after an absence of at least the profile's
 * `threadRecapMinAbsenceMinutes`.
 */
export function recapOffer(
  thread: RecapThread,
  currentUserId: string | null | undefined,
  opened: RecapOpen | undefined,
  profile:
    | (Pick<ProfileResponse, 'threadRecapEnabled'> &
        Partial<Pick<ProfileResponse, 'threadRecapMinAbsenceMinutes'>>)
    | undefined,
): RecapOffer | null {
  if (profile?.threadRecapEnabled !== true || !opened?.newestMessageId) return null;
  if (!canShowRecap(thread, currentUserId)) return null;
  const readFrom = opened.createdAt ?? thread.createdAt;
  const minAbsenceMs =
    (profile.threadRecapMinAbsenceMinutes ?? DEFAULT_THREAD_RECAP_MIN_ABSENCE_MINUTES) * 60_000;
  if (
    !shouldOfferRecap(
      opened.readAt,
      opened.newestActivityAt,
      opened.openedAt,
      readFrom,
      minAbsenceMs,
    )
  ) {
    return null;
  }
  return {
    key: `${thread.id}:${opened.newestMessageId}`,
    body: { since: opened.readAt ?? readFrom, newestMessageId: opened.newestMessageId },
  };
}

export interface RecapQueryState {
  status: 'pending' | 'error' | 'success';
  fetchStatus: 'fetching' | 'paused' | 'idle';
  data: string | null | undefined;
  error: unknown;
}

/** What a recap query's state shows. Every failure but a missing credential shows nothing. */
export function recapView(key: string, query: RecapQueryState): ThreadRecapView {
  if (query.status === 'error') {
    return isUtilityModelUnavailable(query.error) ? { state: 'unavailable', key } : HIDDEN_RECAP;
  }
  if (query.status === 'pending') {
    // Disabled with nothing cached: the utility model is known to have no credential.
    return query.fetchStatus === 'idle' ? HIDDEN_RECAP : { state: 'loading', key };
  }
  return query.data ? { state: 'ready', key, recap: query.data } : HIDDEN_RECAP;
}
