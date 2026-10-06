/**
 * @domain subdomain: Design Management
 * @domain subdomain-type: core
 * @domain type: repository
 * @domain layer: infrastructure
 * @domain depends: Database
 *
 * DB-agnostic design repository. Accepts db + schema via dependency injection.
 */

import { eq, and, desc } from 'drizzle-orm';
import { nanoid } from 'nanoid';

import type { Design, DesignType, DesignFidelity } from '../types.js';
import type { RepoDeps } from './deps.js';

export type DesignRepositoryDeps = RepoDeps;

interface DesignRow {
  id: string;
  projectId: string;
  userId: string;
  name: string;
  type: string;
  fidelity: string | null;
  speakerNotes: number;
  folderPath: string;
  createdAt: string;
  updatedAt: string;
}

function rowToDesign(row: DesignRow): Design {
  return {
    id: row.id,
    projectId: row.projectId,
    userId: row.userId,
    name: row.name,
    type: row.type as DesignType,
    fidelity: row.fidelity as DesignFidelity | null,
    speakerNotes: row.speakerNotes === 1,
    folderPath: row.folderPath,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createDesignRepository(deps: DesignRepositoryDeps) {
  const { db, schema, dbAll, dbGet, dbRun } = deps;

  async function listDesigns(projectId: string, userId: string): Promise<Design[]> {
    const rows = (await dbAll(
      db
        .select()
        .from(schema.designs)
        .where(and(eq(schema.designs.projectId, projectId), eq(schema.designs.userId, userId)))
        .orderBy(desc(schema.designs.createdAt)),
    )) as DesignRow[];
    return rows.map(rowToDesign);
  }

  async function getDesign(id: string): Promise<Design | undefined> {
    const row = (await dbGet(db.select().from(schema.designs).where(eq(schema.designs.id, id)))) as
      | DesignRow
      | undefined;
    return row ? rowToDesign(row) : undefined;
  }

  async function createDesign(data: {
    id?: string;
    projectId: string;
    userId: string;
    name: string;
    type: DesignType;
    fidelity?: DesignFidelity | null;
    speakerNotes?: boolean;
    folderPath: string;
  }): Promise<Design> {
    const id = data.id ?? nanoid();
    const now = new Date().toISOString();
    const fidelity = data.fidelity ?? null;
    const speakerNotes = data.speakerNotes ? 1 : 0;
    await dbRun(
      db.insert(schema.designs).values({
        id,
        projectId: data.projectId,
        userId: data.userId,
        name: data.name,
        type: data.type,
        fidelity,
        speakerNotes,
        folderPath: data.folderPath,
        createdAt: now,
        updatedAt: now,
      }),
    );
    return {
      id,
      projectId: data.projectId,
      userId: data.userId,
      name: data.name,
      type: data.type,
      fidelity,
      speakerNotes: speakerNotes === 1,
      folderPath: data.folderPath,
      createdAt: now,
      updatedAt: now,
    };
  }

  async function deleteDesign(id: string): Promise<void> {
    await dbRun(db.delete(schema.designs).where(eq(schema.designs.id, id)));
  }

  return {
    listDesigns,
    getDesign,
    createDesign,
    deleteDesign,
  };
}
