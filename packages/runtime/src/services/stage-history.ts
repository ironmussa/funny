/**
 * @domain subdomain: Thread Management
 * @domain subdomain-type: core
 * @domain type: repository
 * @domain layer: infrastructure
 * @domain depends: Database
 */

import { createStageHistoryRepository } from '@funny/shared/repositories';

import { db, schema, dbRun } from '../db/index.js';

const repo = createStageHistoryRepository({ db, schema, dbRun });

export const { recordStageChange } = repo;
