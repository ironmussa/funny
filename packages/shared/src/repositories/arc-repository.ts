/**
 * @domain subdomain: Arc Management
 * @domain subdomain-type: core
 * @domain type: repository
 * @domain layer: infrastructure
 * @domain depends: Database
 *
 * DB-agnostic arc repository. Accepts db + schema via dependency injection.
 */

import { eq, and, count as drizzleCount, inArray } from 'drizzle-orm';
import { nanoid } from 'nanoid';

import type {
  AppDatabase,
  dbAll as dbAllFn,
  dbGet as dbGetFn,
  dbRun as dbRunFn,
} from '../db/connection.js';
import type * as sqliteSchema from '../db/schema.sqlite.js';

export interface ArcRepositoryDeps {
  db: AppDatabase;
  schema: typeof sqliteSchema;
  dbAll: typeof dbAllFn;
  dbGet: typeof dbGetFn;
  dbRun: typeof dbRunFn;
}

export function createArcRepository(deps: ArcRepositoryDeps) {
  const { db, schema, dbAll, dbGet, dbRun } = deps;

  /** List arcs for a project, including thread counts */
  async function listArcs(projectId: string, userId: string) {
    const rows = await dbAll(
      db
        .select({
          id: schema.arcs.id,
          projectId: schema.arcs.projectId,
          userId: schema.arcs.userId,
          name: schema.arcs.name,
          createdAt: schema.arcs.createdAt,
          threadCount: drizzleCount(schema.threads.id),
        })
        .from(schema.arcs)
        .leftJoin(schema.threads, eq(schema.threads.arcId, schema.arcs.id))
        .where(and(eq(schema.arcs.projectId, projectId), eq(schema.arcs.userId, userId)))
        .groupBy(schema.arcs.id),
    );
    return rows;
  }

  /** Get a single arc by ID */
  async function getArc(id: string) {
    return dbGet(db.select().from(schema.arcs).where(eq(schema.arcs.id, id)));
  }

  /** Create a new arc */
  async function createArc(data: { projectId: string; userId: string; name: string }) {
    const id = nanoid();
    const createdAt = new Date().toISOString();
    await dbRun(
      db.insert(schema.arcs).values({
        id,
        projectId: data.projectId,
        userId: data.userId,
        name: data.name,
        createdAt,
      }),
    );
    return { id, ...data, createdAt };
  }

  /** Check if an arc name already exists for a project+user */
  async function arcNameExists(projectId: string, userId: string, name: string): Promise<boolean> {
    const row = await dbGet(
      db
        .select({ id: schema.arcs.id })
        .from(schema.arcs)
        .where(
          and(
            eq(schema.arcs.projectId, projectId),
            eq(schema.arcs.userId, userId),
            eq(schema.arcs.name, name),
          ),
        ),
    );
    return !!row;
  }

  /** Delete an arc and unlink any threads referencing it */
  async function deleteArc(id: string) {
    // Unlink threads
    await dbRun(
      db
        .update(schema.threads)
        .set({ arcId: null } as any)
        .where(eq(schema.threads.arcId, id)),
    );
    // Delete the arc record
    await dbRun(db.delete(schema.arcs).where(eq(schema.arcs.id, id)));
  }

  /** List threads linked to an arc */
  async function listArcThreads(arcId: string) {
    return dbAll(db.select().from(schema.threads).where(eq(schema.threads.arcId, arcId)));
  }

  return {
    listArcs,
    getArc,
    createArc,
    arcNameExists,
    deleteArc,
    listArcThreads,
  };
}
