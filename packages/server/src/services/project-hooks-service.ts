/**
 * @domain subdomain: Process Management
 * @domain subdomain-type: supporting
 * @domain type: repository
 * @domain layer: infrastructure
 * @domain depends: Database
 */

import type { HookType } from '@funny/shared';
import { eq, and, asc } from 'drizzle-orm';
import { nanoid } from 'nanoid';

import { db, schema } from '../db/index.js';

/** List hooks for a project, optionally filtered by hookType */
export function listHooks(projectId: string, hookType?: HookType) {
  if (hookType) {
    return db
      .select()
      .from(schema.projectHooks)
      .where(
        and(
          eq(schema.projectHooks.projectId, projectId),
          eq(schema.projectHooks.hookType, hookType),
        ),
      )
      .orderBy(asc(schema.projectHooks.sortOrder))
      .all();
  }
  return db
    .select()
    .from(schema.projectHooks)
    .where(eq(schema.projectHooks.projectId, projectId))
    .orderBy(asc(schema.projectHooks.sortOrder))
    .all();
}

/** List only enabled hooks of a given type for a project */
export function listEnabledHooks(projectId: string, hookType: HookType) {
  return db
    .select()
    .from(schema.projectHooks)
    .where(
      and(
        eq(schema.projectHooks.projectId, projectId),
        eq(schema.projectHooks.hookType, hookType),
        eq(schema.projectHooks.enabled, 1),
      ),
    )
    .orderBy(asc(schema.projectHooks.sortOrder))
    .all();
}

/** Create a hook */
export function createHook(data: {
  projectId: string;
  hookType: HookType;
  label: string;
  command: string;
}) {
  const existing = db
    .select()
    .from(schema.projectHooks)
    .where(eq(schema.projectHooks.projectId, data.projectId))
    .all();

  const entry = {
    id: nanoid(),
    projectId: data.projectId,
    hookType: data.hookType,
    label: data.label,
    command: data.command,
    enabled: 1,
    sortOrder: existing.length,
    createdAt: new Date().toISOString(),
  };

  db.insert(schema.projectHooks).values(entry).run();
  return entry;
}

/** Update a hook */
export function updateHook(
  hookId: string,
  data: {
    label?: string;
    command?: string;
    enabled?: boolean;
    hookType?: HookType;
    sortOrder?: number;
  },
) {
  const updates: Record<string, unknown> = {};
  if (data.label !== undefined) updates.label = data.label;
  if (data.command !== undefined) updates.command = data.command;
  if (data.enabled !== undefined) updates.enabled = data.enabled ? 1 : 0;
  if (data.hookType !== undefined) updates.hookType = data.hookType;
  if (data.sortOrder !== undefined) updates.sortOrder = data.sortOrder;

  db.update(schema.projectHooks).set(updates).where(eq(schema.projectHooks.id, hookId)).run();
}

/** Delete a hook */
export function deleteHook(hookId: string) {
  db.delete(schema.projectHooks).where(eq(schema.projectHooks.id, hookId)).run();
}

/** Get a single hook by ID */
export function getHook(hookId: string) {
  return db.select().from(schema.projectHooks).where(eq(schema.projectHooks.id, hookId)).get();
}
