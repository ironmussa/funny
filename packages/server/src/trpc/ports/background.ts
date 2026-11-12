/**
 * Watchers and jobs of the caller's agents, for both `/api/watchers` +
 * `/api/jobs` (REST) and the `watchers` / `jobs` tRPC routers. Both are
 * persisted in the server DB; job cancel and log reads stay REST, proxied to
 * the runner that owns the process and its logfile.
 */

import { failure, type JobsPort, type WatchersPort } from '@funny/api';
import type { Job, JobStatus, Watcher, WatcherStatus } from '@funny/shared';
import { and, desc, eq } from 'drizzle-orm';
import { err, ok } from 'neverthrow';

import { db } from '../../db/index.js';
import { jobs, watchers } from '../../db/schema.js';

type WatcherRow = typeof watchers.$inferSelect;
type JobRow = typeof jobs.$inferSelect;

const toWatcher = (row: WatcherRow): Watcher => ({ ...row, status: row.status as WatcherStatus });
const toJob = (row: JobRow): Job => ({ ...row, status: row.status as JobStatus });

export const watchersPort: WatchersPort = {
  async list(userId) {
    const rows = await db
      .select()
      .from(watchers)
      .where(eq(watchers.userId, userId))
      .orderBy(desc(watchers.createdAt));
    return ok(rows.map(toWatcher));
  },

  // Cancel just flips the DB status; the runner's scanner only fires `pending`
  // rows, so it stops on its own.
  async cancel(userId, id) {
    const rows = await db
      .select()
      .from(watchers)
      .where(and(eq(watchers.id, id), eq(watchers.userId, userId)));
    if (!rows[0]) return err(failure(404, 'Not found'));

    // Only live watchers can be cancelled; terminal states stay as they are.
    if (rows[0].status === 'pending' || rows[0].status === 'fired') {
      await db
        .update(watchers)
        .set({ status: 'cancelled', updatedAt: new Date().toISOString() })
        .where(eq(watchers.id, id));
    }
    const updated = await db.select().from(watchers).where(eq(watchers.id, id));
    return ok(toWatcher(updated[0]));
  },
};

export const jobsPort: JobsPort = {
  async list(userId) {
    const rows = await db
      .select()
      .from(jobs)
      .where(eq(jobs.userId, userId))
      .orderBy(desc(jobs.startedAt));
    return ok(rows.map(toJob));
  },
};
