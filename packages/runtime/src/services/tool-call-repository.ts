/**
 * @domain subdomain: Thread Management
 * @domain subdomain-type: core
 * @domain type: repository
 * @domain layer: infrastructure
 * @domain aggregate: Thread
 * @domain depends: Database
 */

import { createToolCallRepository } from '@funny/shared/repositories';

import { db, dbGet, dbRun, schema } from '../db/index.js';

const repo = createToolCallRepository({ db, schema, dbGet, dbRun });

export const {
  insertToolCall,
  updateToolCallOutput,
  findToolCall,
  getToolCall,
  findLastUnansweredInteractiveToolCall,
} = repo;
