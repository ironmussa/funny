import { eq, asc } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db, schema } from '../db/index.js';

/** List startup commands for a project, ordered by sortOrder */
export function listCommands(projectId: string) {
  return db
    .select()
    .from(schema.startupCommands)
    .where(eq(schema.startupCommands.projectId, projectId))
    .orderBy(asc(schema.startupCommands.sortOrder))
    .all();
}

/** Create a startup command */
export function createCommand(data: {
  projectId: string;
  label: string;
  command: string;
}) {
  const existing = db
    .select()
    .from(schema.startupCommands)
    .where(eq(schema.startupCommands.projectId, data.projectId))
    .all();

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

  db.insert(schema.startupCommands).values(entry).run();
  return entry;
}

/** Update a startup command */
export function updateCommand(cmdId: string, data: {
  label: string;
  command: string;
}) {
  db.update(schema.startupCommands)
    .set({
      label: data.label,
      command: data.command,
    })
    .where(eq(schema.startupCommands.id, cmdId))
    .run();
}

/** Delete a startup command */
export function deleteCommand(cmdId: string) {
  db.delete(schema.startupCommands)
    .where(eq(schema.startupCommands.id, cmdId))
    .run();
}

/** Get a single command by ID */
export function getCommand(cmdId: string) {
  return db
    .select()
    .from(schema.startupCommands)
    .where(eq(schema.startupCommands.id, cmdId))
    .get();
}
