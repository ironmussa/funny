/**
 * Startup commands CRUD backed by the server's database.
 */

import { and, eq, asc } from 'drizzle-orm';
import { nanoid } from 'nanoid';

import { db, dbAll, dbGet, dbRun } from '../db/index.js';
import { startupCommands } from '../db/schema.js';

// Security CR-6: updateCommand / deleteCommand previously filtered by command
// id alone, letting an authenticated user who guessed a row id mutate any
// project's startup command — and the command body is shell-exec'd by
// `command-runner.ts`. The mutating helpers now require the parent
// projectId; the route layer is expected to verify project ownership before
// calling.

export async function listCommands(projectId: string) {
  return dbAll(
    db
      .select()
      .from(startupCommands)
      .where(eq(startupCommands.projectId, projectId))
      .orderBy(asc(startupCommands.sortOrder)),
  );
}

export async function createCommand(data: { projectId: string; label: string; command: string }) {
  const existing = await dbAll(
    db.select().from(startupCommands).where(eq(startupCommands.projectId, data.projectId)),
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

  await dbRun(db.insert(startupCommands).values(entry));
  return entry;
}

export async function updateCommand(
  cmdId: string,
  projectId: string,
  data: { label: string; command: string; port?: number; portEnvVar?: string },
) {
  await dbRun(
    db
      .update(startupCommands)
      .set({
        label: data.label,
        command: data.command,
        port: data.port ?? null,
        portEnvVar: data.portEnvVar ?? null,
      })
      .where(and(eq(startupCommands.id, cmdId), eq(startupCommands.projectId, projectId))),
  );
}

export async function deleteCommand(cmdId: string, projectId: string) {
  await dbRun(
    db
      .delete(startupCommands)
      .where(and(eq(startupCommands.id, cmdId), eq(startupCommands.projectId, projectId))),
  );
}

export async function getCommand(cmdId: string, projectId: string) {
  return dbGet(
    db
      .select()
      .from(startupCommands)
      .where(and(eq(startupCommands.id, cmdId), eq(startupCommands.projectId, projectId))),
  );
}
