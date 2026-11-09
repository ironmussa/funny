import type { DomainError } from '@funny/shared/errors';
import type { ResultAsync } from 'neverthrow';

import { threadsApi } from '@/lib/api/threads';

import type { DataLayer } from '../data-layer';
import { getDataLayer } from '../runtime';
import { patchQueuedMessage, removeQueuedMessage } from './store';

/** Queue edits. Each waits for the server, then records the confirmed change. */

export function editQueuedMessage(
  threadId: string,
  messageId: string,
  content: string,
  layer: DataLayer = getDataLayer(),
): ResultAsync<void, DomainError> {
  return threadsApi
    .updateQueuedMessage(threadId, messageId, content)
    .map(() => patchQueuedMessage(threadId, messageId, content, layer));
}

export function cancelQueuedMessage(
  threadId: string,
  messageId: string,
  layer: DataLayer = getDataLayer(),
): ResultAsync<void, DomainError> {
  return threadsApi
    .cancelQueuedMessage(threadId, messageId)
    .map(({ queuedCount }) => removeQueuedMessage(threadId, messageId, queuedCount, layer));
}
