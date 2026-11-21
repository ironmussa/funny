import type { Activity } from '@funny/shared';
import type { DomainError } from '@funny/shared/errors';
import { okAsync, ResultAsync } from 'neverthrow';

import { activitiesApi } from '@/lib/api/activities';
import { createClientLogger } from '@/lib/client-logger';

import type { DataLayer } from '../data-layer';
import { toDomainError, unwrapResult } from '../query-client';
import { getDataLayer } from '../runtime';
import { getActivitiesData } from './store';

const log = createClientLogger('activities');

/** Load the user's complete list; concurrent loads share one request. */
export function loadActivities(
  layer: DataLayer = getDataLayer(),
): ResultAsync<Activity[] | null, DomainError> {
  if (!layer.userId) return okAsync(null);
  return ResultAsync.fromPromise(
    layer.queryClient.fetchQuery({
      queryKey: ['activities'],
      staleTime: 0,
      queryFn: async () => {
        const rows = await unwrapResult(activitiesApi.listActivities());
        getActivitiesData(layer).replaceAll(rows);
        return rows;
      },
    }),
    toDomainError,
  ).mapErr((error) => {
    log.warn('failed to load activities', { error: error.message });
    return error;
  });
}
