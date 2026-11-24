import i18n from '@/i18n/config';

import { useDataQuery } from '../hooks';
import { useProfile } from '../profile/hooks';
import {
  HIDDEN_RECAP,
  recapOffer,
  recapView,
  type RecapOpen,
  type RecapThread,
  type ThreadRecapView,
} from './offer';
import { recapUnavailableQuery, threadRecapQuery, utilityModelFingerprint } from './queries';

export type { RecapOpen, ThreadRecapView } from './offer';

/**
 * The recap of the open thread (openspec `thread-recap`). A request is made
 * only when the profile has recaps on, the viewer may see one
 * (`canShowRecap`), the open found activity after an absence
 * (`shouldOfferRecap`), the card is not dismissed, and the utility model has
 * not already been found without a credential.
 */
export function useThreadRecap(
  thread: RecapThread,
  currentUserId: string | null | undefined,
  opened: RecapOpen | undefined,
  dismissed: (key: string) => boolean,
): ThreadRecapView {
  const profile = useProfile();
  const unavailableFor = useDataQuery(recapUnavailableQuery).data;
  const offer = recapOffer(thread, currentUserId, opened, profile);
  const visible = !!offer && !dismissed(offer.key);
  const fingerprint = utilityModelFingerprint(profile?.utilityModel);

  const query = useDataQuery({
    ...threadRecapQuery(
      thread.id,
      {
        since: offer?.body.since ?? thread.createdAt,
        newestMessageId: offer?.body.newestMessageId ?? '',
        language: i18n.language || 'en',
      },
      fingerprint,
    ),
    enabled: visible && unavailableFor !== fingerprint,
  });

  return offer && visible ? recapView(offer.key, query) : HIDDEN_RECAP;
}
