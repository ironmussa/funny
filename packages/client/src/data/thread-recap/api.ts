import type { DomainError } from '@funny/shared/errors';
import type { ResultAsync } from 'neverthrow';

import { requestInThread } from '@/lib/api/_core';

/** Body of the runner's `POST /api/threads/:id/recap` (runtime `routes/thread-recap.ts`). */
export interface ThreadRecapRequest {
  /** The owner's read marker before the open (ISO); the recap covers what came after. */
  since: string;
  newestMessageId: string;
  /** The interface language (`en`, `es`, `pt`). */
  language: string;
}

export interface ThreadRecapResponse {
  /** `null` when nothing happened after `since`. */
  recap: string | null;
  newestMessageId: string;
}

/**
 * The runtime's error `code` for a utility model with no credential. The
 * route answers it as the error message as well, which is what reaches the
 * client's `DomainError`.
 */
export const UTILITY_MODEL_UNAVAILABLE = 'utility-model-unavailable';

export const threadRecapApi = {
  generate: (
    threadId: string,
    body: ThreadRecapRequest,
  ): ResultAsync<ThreadRecapResponse, DomainError> =>
    requestInThread<ThreadRecapResponse>(`/threads/${encodeURIComponent(threadId)}/recap`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
};
