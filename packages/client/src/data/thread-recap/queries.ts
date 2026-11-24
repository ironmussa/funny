import type { UtilityModelSetting } from '@funny/shared/contracts/profile';

import { createClientLogger } from '@/lib/client-logger';
import { metric } from '@/lib/telemetry';

import type { DataLayer } from '../data-layer';
import { DataRequestError, unwrapResult } from '../query-client';
import { getDataLayer } from '../runtime';
import { threadRecapApi, UTILITY_MODEL_UNAVAILABLE, type ThreadRecapRequest } from './api';

/**
 * Thread recaps (openspec `thread-recap`, D5) as session queries keyed by
 * thread and newest message: a recap never goes stale (`staleTime: Infinity`),
 * so reopening a thread with no new activity reuses it, and only a newer
 * message makes a new key. The layer is per session, so a logout drops them.
 * React reads them through `hooks.ts`.
 */

const log = createClientLogger('thread-recap');

function threadRecapKey(threadId: string, newestMessageId: string) {
  return ['thread-recap', threadId, newestMessageId] as const;
}

/** Whether a failed recap request was the utility model's missing credential. */
export function isUtilityModelUnavailable(error: unknown): boolean {
  return (
    error instanceof DataRequestError && error.domainError.message === UTILITY_MODEL_UNAVAILABLE
  );
}

/** Stable identity of the user's utility model setting (`null` = the default). */
export function utilityModelFingerprint(setting: UtilityModelSetting | null | undefined): string {
  return setting ? JSON.stringify([setting.provider, setting.model, setting.baseURL ?? '']) : '';
}

/**
 * The utility model setting a recap failed for with no credential. While the
 * setting stays the same, no other recap is asked for this session: every one
 * would fail the same way. Changing the setting asks again.
 */
export const recapUnavailableQuery = {
  queryKey: ['thread-recap-unavailable'] as const,
  queryFn: (): string | null => null,
  staleTime: Infinity,
  enabled: false,
};

export function threadRecapQuery(
  threadId: string,
  body: ThreadRecapRequest,
  utilityModel: string,
  layer: DataLayer = getDataLayer(),
) {
  return {
    queryKey: threadRecapKey(threadId, body.newestMessageId),
    queryFn: async (): Promise<string | null> => {
      try {
        const { recap } = await unwrapResult(threadRecapApi.generate(threadId, body));
        metric('thread.recap.received', 1, { attributes: { empty: String(recap === null) } });
        return recap;
      } catch (error) {
        const unavailable = isUtilityModelUnavailable(error);
        metric('thread.recap.failed', 1, { attributes: { unavailable: String(unavailable) } });
        log.warn('thread recap failed', {
          threadId,
          error: error instanceof Error ? error.message : String(error),
        });
        if (unavailable && !layer.disposed) {
          layer.queryClient.setQueryData(recapUnavailableQuery.queryKey, utilityModel);
        }
        throw error;
      }
    },
    staleTime: Infinity,
    gcTime: Infinity,
  };
}
