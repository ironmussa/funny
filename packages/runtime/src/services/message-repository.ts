/**
 * @domain subdomain: Thread Management
 * @domain subdomain-type: core
 * @domain type: repository
 * @domain layer: infrastructure
 * @domain aggregate: Thread
 * @domain depends: Database
 */

import { createMessageRepository } from '@funny/shared/repositories';

import { db, schema, dbAll, dbGet, dbRun } from '../db/index.js';

const repo = createMessageRepository({ db, schema, dbAll, dbGet, dbRun });

export const { getThreadWithMessages, getThreadMessages, insertMessage, updateMessage } = repo;
