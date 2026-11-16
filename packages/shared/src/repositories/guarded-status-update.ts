import { and, eq, inArray } from 'drizzle-orm';

import type { RepoDeps } from './deps.js';

/**
 * Patch one row of a table whose `status` column follows a machine. A patch
 * that carries a `status` is a transition: it is applied only from a status
 * `writtenFrom` allows for it (compare-and-set). Returns false when nothing was
 * written — no such row, or the row is no longer in a status the transition is
 * legal from.
 */
/** The tables whose status writes go through this guard. */
type GuardedTable = RepoDeps['schema']['watchers'] | RepoDeps['schema']['jobs'];

export async function updateWithStatusGuard<S extends string>(
  deps: Pick<RepoDeps, 'db' | 'dbAll'>,
  table: GuardedTable,
  id: string,
  patch: Partial<GuardedTable['$inferInsert']> & { status?: S },
  writtenFrom: Readonly<Record<S, readonly S[]>>,
): Promise<boolean> {
  // An unknown status has no legal source: `inArray(…, [])` matches no row.
  const from = patch.status === undefined ? null : (writtenFrom[patch.status] ?? []);
  const rows = await deps.dbAll<{ id: string }>(
    deps.db
      .update(table)
      .set({ updatedAt: new Date().toISOString(), ...patch })
      .where(from ? and(eq(table.id, id), inArray(table.status, [...from])) : eq(table.id, id))
      .returning({ id: table.id }),
  );
  return rows.length > 0;
}
