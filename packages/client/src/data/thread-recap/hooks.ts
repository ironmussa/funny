import type { Thread } from '@funny/shared';

import i18n from '@/i18n/config';
import { canShowRecap, shouldOfferRecap } from '@/lib/thread-variant';

import { useDataQuery } from '../hooks';
import { useProfile } from '../profile/hooks';
import {
  isUtilityModelUnavailable,
  recapUnavailableQuery,
  threadRecapQuery,
  utilityModelFingerprint,
} from './queries';

/**
 * What the recap card shows for the open thread (openspec `thread-recap`).
 * `key` is `threadId:newestMessageId`, the unit a dismissal hides.
 */
export type ThreadRecapView =
  | { state: 'hidden' }
  | { state: 'loading'; key: string }
  | { state: 'ready'; key: string; recap: string }
  | { state: 'unavailable'; key: string };

const HIDDEN: ThreadRecapView = { state: 'hidden' };

/** The thread's open snapshot (`stores/thread-read-store.ts` `ThreadOpenSnapshot`). */
export interface RecapOpen {
  readAt: string | null;
  openedAt: number;
  createdAt: string | null;
  newestMessageId: string | null;
  newestActivityAt: string | null;
}

type RecapThread = Pick<Thread, 'id' | 'userId' | 'createdAt'> & { runtime?: string | null };

/**
 * The recap of the open thread. A request is made only when the profile has
 * recaps on, the viewer may see one (`canShowRecap`), the open found activity
 * after an absence (`shouldOfferRecap`), the card is not dismissed, and the
 * utility model has not already been found without a credential.
 */
export function useThreadRecap(
  thread: RecapThread,
  currentUserId: string | null | undefined,
  opened: RecapOpen | undefined,
  dismissed: (key: string) => boolean,
): ThreadRecapView {
  const profile = useProfile();
  const unavailableFor = useDataQuery(recapUnavailableQuery).data;

  const recapsOn = profile?.threadRecapEnabled === true;
  const newestMessageId = opened?.newestMessageId ?? null;
  const offered =
    recapsOn &&
    !!opened &&
    !!newestMessageId &&
    canShowRecap(thread, currentUserId) &&
    shouldOfferRecap(
      opened.readAt,
      opened.newestActivityAt,
      opened.openedAt,
      opened.createdAt ?? thread.createdAt,
    );
  const key = `${thread.id}:${newestMessageId ?? ''}`;
  const isDismissed = dismissed(key);
  const fingerprint = utilityModelFingerprint(profile?.utilityModel);
  const since = opened?.readAt ?? opened?.createdAt ?? thread.createdAt;

  const query = useDataQuery({
    ...threadRecapQuery(
      thread.id,
      { since, newestMessageId: newestMessageId ?? '', language: i18n.language || 'en' },
      fingerprint,
    ),
    enabled: offered && !isDismissed && unavailableFor !== fingerprint,
  });

  if (!offered || isDismissed) return HIDDEN;
  if (query.status === 'error') {
    return isUtilityModelUnavailable(query.error) ? { state: 'unavailable', key } : HIDDEN;
  }
  if (query.status === 'pending') {
    // Disabled with nothing cached: the credential is missing for this model.
    return query.fetchStatus === 'idle' ? HIDDEN : { state: 'loading', key };
  }
  return query.data ? { state: 'ready', key, recap: query.data } : HIDDEN;
}
