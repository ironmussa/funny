/**
 * @domain subdomain: Process Management
 * @domain subdomain-type: supporting
 * @domain type: repository
 * @domain layer: infrastructure
 * @domain depends: Database
 */

import { eq, asc } from 'drizzle-orm';
import { nanoid } from 'nanoid';

import { db, dbAll, dbGet, dbRun, schema } from '../db/index.js';

/** List startup commands for a project, ordered by sortOrder */
export async function listCommands(projectId: string) {
  return dbAll(
    db
      .select()
      .from(schema.startupCommands)
      .where(eq(schema.startupCommands.projectId, projectId))
      .orderBy(asc(schema.startupCommands.sortOrder)),
  );
}

/** Create a startup command */
export async function createCommand(data: { projectId: string; label: string; command: string }) {
  const existing = await dbAll(
    db
      .select()
      .from(schema.startupCommands)
      .where(eq(schema.startupCommands.projectId, data.projectId)),
  );

  const entry = {
    id: nanoid(),
    projectId: data.projectId,
    label: data.label,
    command: data.command,
    port: null,
    portEnvVar: null,
    sortOrder: existing.length,
    createdAt: new Date().toISOString(),
  };

  await dbRun(db.insert(schema.startupCommands).values(entry));
  return entry;
}

/** Update a startup command */
export async function updateCommand(
  cmdId: string,
  data: {
    label: string;
    command: string;
    port?: number;
    portEnvVar?: string;
  },
) {
  await dbRun(
    db
      .update(schema.startupCommands)
      .set({
        label: data.label,
        command: data.command,
        port: data.port ?? null,
        portEnvVar: data.portEnvVar ?? null,
      })
      .where(eq(schema.startupCommands.id, cmdId)),
  );
}

/** Delete a startup command */
export async function deleteCommand(cmdId: string) {
  await dbRun(db.delete(schema.startupCommands).where(eq(schema.startupCommands.id, cmdId)));
}

/** Get a single command by ID */
export async function getCommand(cmdId: string) {
  return dbGet(
    db.select().from(schema.startupCommands).where(eq(schema.startupCommands.id, cmdId)),
  );
}
