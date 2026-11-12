import type { ProfileResponse } from '@funny/shared/contracts/profile';

import { useDataQuery } from '../hooks';
import { profileQuery } from './queries';

/** The signed-in user's profile; fetched on first use, then kept current by profile writes. */
export function useProfile(): ProfileResponse | undefined {
  return useDataQuery(profileQuery()).data;
}
