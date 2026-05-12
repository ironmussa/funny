/**
 * @domain subdomain: Orchestration
 * @domain subdomain-type: core
 * @domain type: adapter
 * @domain layer: infrastructure
 * @domain depends: Database
 *
 * SQL adapter that backs the orchestrator's eligibility queries.
 * Implements `ThreadQueryAdapter` against Drizzle
 * + the shared schema so the service stays DB-agnostic.
 *
 * `createThreadQuery` accepts injected db/schema so it can be
 * exercised in tests without booting the server's DB proxy.
 * `createDefaultThreadQuery` wires it to the shared `db` proxy used
 * everywhere else in the server.
 */

import type { Thread } from '@funny/shared';
import type { AppDatabase } from '@funny/shared/db/connection';
import { dbAll, dbGet } from '@funny/shared/db/connection';
import type { ThreadQueryAdapter } from '@funny/thread-orchestrator';
import { and, eq, inArray, notInArray, sql } from 'drizzle-orm';

import { db as defaultDb } from '../db/index.js';
import * as defaultSchema from '../db/schema.js';

const ELIGIBLE_STAGES = ['backlog', 'planning', 'in_progress'] as const;
const TERMINAL_STAGES = ['done', 'archived'] as const;
const RUNNING_STATUSES = ['running', 'setting_up', 'completed'] as const;

export interface ThreadQueryDeps {
  db: AppDatabase;
  schema: typeof defaultSchema;
}

export function createThreadQuery(deps: ThreadQueryDeps): ThreadQueryAdapter {
  const { db, schema } = deps;

  return {
    async listEligibleCandidates(): Promise<Thread[]> {
      // Pre-filter: ineligible if a row already exists in
      // orchestrator_runs (means we've already claimed it). Doing
      // this as a separate query keeps the SELECT below indexable on
      // (stage, status) without a correlated subquery.
      const claimed = await dbAll<{ threadId: string }>(
        db.select({ threadId: schema.orchestratorRuns.threadId }).from(schema.orchestratorRuns),
      );
      const claimedIds = claimed.map((c) => c.threadId);

      const filters = [
        eq(schema.threads.orchestratorManaged, 1),
        inArray(schema.threads.stage, ELIGIBLE_STAGES as unknown as string[]),
        notInArray(schema.threads.status, RUNNING_STATUSES as unknown as string[]),
        eq(schema.threads.archived, 0),
      ];
      if (claimedIds.length > 0) {
        filters.push(notInArray(schema.threads.id, claimedIds));
      }

      const rows = await dbAll<Thread>(
        db
          .select()
          .from(schema.threads)
          .where(and(...filters))
          .orderBy(sql`${schema.threads.createdAt} ASC`, sql`${schema.threads.id} ASC`),
      );
      return rows;
    },

    async listTerminalThreadIds(): Promise<Set<string>> {
      const rows = await dbAll<{ id: string }>(
        db
          .select({ id: schema.threads.id })
          .from(schema.threads)
          .where(inArray(schema.threads.stage, TERMINAL_STAGES as unknown as string[])),
      );
      return new Set(rows.map((r) => r.id));
    },

    async getThreadById(id: string): Promise<Thread | null> {
      const row = await dbGet<Thread>(
        db.select().from(schema.threads).where(eq(schema.threads.id, id)),
      );
      return row ?? null;
    },
  };
}

export function createDefaultThreadQuery(): ThreadQueryAdapter {
  return createThreadQuery({ db: defaultDb, schema: defaultSchema });
}
