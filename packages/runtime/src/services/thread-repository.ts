/**
 * @domain subdomain: Thread Management
 * @domain subdomain-type: core
 * @domain type: repository
 * @domain layer: infrastructure
 * @domain aggregate: Thread
 * @domain depends: Database, StageHistory, CommentRepository
 */

import {
  createThreadRepository,
  createCommentRepository,
  createStageHistoryRepository,
} from '@funny/shared/repositories';

import { db, schema, dbAll, dbGet, dbRun } from '../db/index.js';
import { log } from '../lib/logger.js';

const commentRepo = createCommentRepository({ db, schema, dbAll, dbRun });
const stageHistoryRepo = createStageHistoryRepository({ db, schema, dbRun });

const repo = createThreadRepository({
  db,
  schema,
  dbAll,
  dbGet,
  dbRun,
  log,
  commentRepo,
  stageHistoryRepo,
});

export const {
  listThreads,
  listArchivedThreads,
  getThread,
  getThreadByExternalRequestId,
  createThread,
  updateThread,
  deleteThread,
  markStaleThreadsInterrupted,
  markStaleExternalThreadsStopped,
} = repo;
