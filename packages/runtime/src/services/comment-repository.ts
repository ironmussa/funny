/**
 * @domain subdomain: Thread Management
 * @domain subdomain-type: core
 * @domain type: repository
 * @domain layer: infrastructure
 * @domain depends: Database
 */

import { createCommentRepository } from '@funny/shared/repositories';

import { db, dbAll, dbRun, schema } from '../db/index.js';

const repo = createCommentRepository({ db, schema, dbAll, dbRun });

export const { listComments, insertComment, deleteComment, getCommentCounts } = repo;
