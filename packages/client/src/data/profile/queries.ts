import type { UserProfile } from '@funny/shared';

import { profileApi } from '@/lib/api/profile';

import type { DataLayer } from '../data-layer';
import { unwrapResult } from '../query-client';
import { getDataLayer } from '../runtime';

/**
 * The signed-in user's profile (`GET /profile`) as one session query. It only
 * changes through this session's own writes, so it never goes stale on its
 * own: every successful profile write records the server's response with
 * `writeProfile`, and the settings page asks for a fresh copy on open
 * (`refreshProfile`). The layer is per session, so a logout drops it.
 */

const profileKey = ['profile'] as const;

export function profileQuery() {
  return {
    queryKey: profileKey,
    queryFn: (): Promise<UserProfile> => unwrapResult(profileApi.getProfile()),
    staleTime: Infinity,
    gcTime: Infinity,
  };
}

/** The cached profile, fetching it when there is none. Rejects when the request fails. */
export function loadProfile(layer: DataLayer = getDataLayer()): Promise<UserProfile> {
  return layer.queryClient.fetchQuery(profileQuery());
}

/** Fetch a fresh copy, keeping the cached one if the request fails. */
export async function refreshProfile(layer: DataLayer = getDataLayer()): Promise<void> {
  await layer.queryClient.fetchQuery({ ...profileQuery(), staleTime: 0 }).catch(() => undefined);
}

/** Record the profile a write returned (the server's confirmed state). */
export function writeProfile(profile: UserProfile, layer: DataLayer = getDataLayer()): void {
  if (layer.disposed) return;
  layer.queryClient.setQueryData<UserProfile>(profileKey, profile);
}
