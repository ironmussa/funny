import type { UpdateProfileRequest, UserProfile } from '@funny/shared';
import type { DomainError } from '@funny/shared/errors';
import type { ResultAsync } from 'neverthrow';

import { profileApi } from '@/lib/api/profile';

import type { DataLayer } from '../data-layer';
import { getDataLayer } from '../runtime';
import { writeProfile } from './queries';

/**
 * Profile writes. Each records the profile the server returns, so readers of
 * `useProfile` (e.g. the dictation button's `hasAssemblyaiKey`) see the change
 * without a reload.
 */

export function updateProfile(
  data: UpdateProfileRequest,
  layer: DataLayer = getDataLayer(),
): ResultAsync<UserProfile, DomainError> {
  return profileApi.updateProfile(data).map((profile) => {
    writeProfile(profile, layer);
    return profile;
  });
}

export function completeSetup(
  layer: DataLayer = getDataLayer(),
): ResultAsync<UserProfile, DomainError> {
  return profileApi.completeSetup().map((profile) => {
    writeProfile(profile, layer);
    return profile;
  });
}
