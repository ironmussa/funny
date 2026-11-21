/**
 * The server's shared repositories (`@funny/shared/repositories`), each built
 * once on first use against the server DB. Import from here instead of calling
 * `create*Repository({ db, schema, … })` at every call site.
 */

import {
  createActivityRepository,
  createCommentRepository,
  createDesignRepository,
  createGrantRepository,
  createJobRepository,
  createMessageRepository,
  createPendingPermissionRepository,
  createSchedulerRunRepository,
  createStageHistoryRepository,
  createThreadRepository,
  createThreadShareRepository,
  createToolCallRepository,
  createWatcherRepository,
} from '@funny/shared/repositories';

import { observeThreadStatusWrite } from '../services/thread-status-observer.js';
import { db, dbAll, dbGet, dbRun } from './index.js';
import * as schema from './schema.js';

const deps = { db, schema, dbAll, dbGet, dbRun };

function lazy<T>(create: () => T): () => T {
  let instance: T | undefined;
  return () => (instance ??= create());
}

const comments = lazy(() => createCommentRepository(deps));
const stageHistory = lazy(() => createStageHistoryRepository(deps));

export const repos = {
  activities: lazy(() => createActivityRepository(deps)),
  comments,
  designs: lazy(() => createDesignRepository(deps)),
  grants: lazy(() => createGrantRepository(deps)),
  jobs: lazy(() => createJobRepository(deps)),
  messages: lazy(() => createMessageRepository(deps)),
  pendingPermissions: lazy(() => createPendingPermissionRepository(deps)),
  schedulerRuns: lazy(() => createSchedulerRunRepository(deps)),
  stageHistory,
  threads: lazy(() =>
    createThreadRepository({
      ...deps,
      commentRepo: comments(),
      stageHistoryRepo: stageHistory(),
      // Log-only: counts status writes the thread machine does not model.
      onStatusWrite: observeThreadStatusWrite,
    }),
  ),
  threadShares: lazy(() => createThreadShareRepository(deps)),
  toolCalls: lazy(() => createToolCallRepository(deps)),
  watchers: lazy(() => createWatcherRepository(deps)),
};
