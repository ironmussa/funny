/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: application-service
 * @domain layer: application
 *
 * Each user's issue factory for a project (change issue-factory): the on/off
 * toggle plus the watched label, the flow to run and the concurrency. Keyed per
 * `(project, user)` and scoped to project access: anyone who may start threads
 * on the project (`steer`) runs their own factory; a viewer may only read
 * theirs. Runs are stored separately (`factory-runs`).
 */
import { and, eq } from 'drizzle-orm';
import { errAsync, ResultAsync } from 'neverthrow';

import { db } from '../../db/index.js';
import { factorySettings } from '../../db/schema.js';
import { requireProjectAccess } from '../project-access.js';

export interface FactorySettingsView {
  projectId: string;
  enabled: boolean;
  label: string;
  flowName: string;
  maxConcurrent: number;
  updatedAt: string;
}

export type FactorySettingsError =
  | { kind: 'not-found'; message: string }
  /** The caller can see the project but their role does not allow this. */
  | { kind: 'forbidden'; message: string }
  | { kind: 'invalid'; message: string }
  | { kind: 'storage'; message: string };

export interface SaveFactorySettingsInput {
  enabled: boolean;
  label?: string;
  flowName?: string;
  maxConcurrent?: number;
}

type Row = typeof factorySettings.$inferSelect;

const storage = (error: unknown): FactorySettingsError => ({
  kind: 'storage',
  message: error instanceof Error ? error.message : String(error),
});

const accessErrors = {
  storage,
  notFound: (): FactorySettingsError => ({ kind: 'not-found', message: 'Project not found' }),
  forbidden: (): FactorySettingsError => ({
    kind: 'forbidden',
    message: 'Running an issue factory needs contributor access to the project',
  }),
};

const toView = (row: Row): FactorySettingsView => ({
  projectId: row.projectId,
  enabled: row.enabled === 1,
  label: row.label,
  flowName: row.flowName,
  maxConcurrent: row.maxConcurrent,
  updatedAt: row.updatedAt,
});

const byOwner = (userId: string, projectId: string) =>
  and(eq(factorySettings.projectId, projectId), eq(factorySettings.userId, userId));

function validate(input: SaveFactorySettingsInput): FactorySettingsError | null {
  if (input.label !== undefined && input.label.trim() === '') {
    return { kind: 'invalid', message: 'Label must not be empty' };
  }
  if (input.maxConcurrent !== undefined && (input.maxConcurrent < 1 || input.maxConcurrent > 20)) {
    return { kind: 'invalid', message: 'maxConcurrent must be between 1 and 20' };
  }
  return null;
}

const DEFAULTS = { label: 'ready-for-agent', flowName: 'issue-to-merge', maxConcurrent: 2 };

/** The row to upsert, carrying forward the caller's existing values when a field is omitted. */
function buildRow(
  id: string,
  userId: string,
  projectId: string,
  input: SaveFactorySettingsInput,
  existing: FactorySettingsView | null,
): Row {
  const now = new Date().toISOString();
  const base = existing ?? DEFAULTS;
  return {
    id,
    projectId,
    userId,
    enabled: input.enabled ? 1 : 0,
    label: input.label ?? base.label,
    flowName: input.flowName ?? base.flowName,
    maxConcurrent: input.maxConcurrent ?? base.maxConcurrent,
    createdAt: now,
    updatedAt: now,
  };
}

/** A factory the watcher should poll — server-internal, unscoped (like `listAutomations`). */
export interface EnabledFactory {
  id: string;
  projectId: string;
  userId: string;
  label: string;
  flowName: string;
  maxConcurrent: number;
}

const toEnabled = (row: Row): EnabledFactory => ({
  id: row.id,
  projectId: row.projectId,
  userId: row.userId,
  label: row.label,
  flowName: row.flowName,
  maxConcurrent: row.maxConcurrent,
});

/**
 * Every enabled factory across all users/projects, for the watcher. Server-only
 * (no access check): the watcher acts as each factory's own enabling user.
 */
export async function listEnabledFactories(): Promise<EnabledFactory[]> {
  const rows = await db.select().from(factorySettings).where(eq(factorySettings.enabled, 1));
  return rows.map(toEnabled);
}

/** One factory by its id, or null — the watcher re-reads it each tick. */
export async function getEnabledFactory(id: string): Promise<EnabledFactory | null> {
  const [row] = await db.select().from(factorySettings).where(eq(factorySettings.id, id));
  return row && row.enabled === 1 ? toEnabled(row) : null;
}

/**
 * Turn a factory off from the server (no caller to authorize) — the watcher
 * does this when its enabler can no longer start threads on the project.
 */
export async function disableFactory(id: string): Promise<void> {
  await db
    .update(factorySettings)
    .set({ enabled: 0, updatedAt: new Date().toISOString() })
    .where(eq(factorySettings.id, id));
}

export function createFactorySettingsService(
  deps: { newId: () => string } = { newId: () => crypto.randomUUID() },
) {
  const find = (userId: string, projectId: string) =>
    ResultAsync.fromPromise(
      db.select().from(factorySettings).where(byOwner(userId, projectId)),
      storage,
    ).map(([row]) => (row ? toView(row) : null));

  const upsert = (row: Row): ResultAsync<FactorySettingsView, FactorySettingsError> => {
    // On conflict keep the row's existing id and created_at; change only the
    // mutable fields (id/created_at are excluded from `set`).
    const { id: _id, projectId: _p, userId: _u, createdAt: _c, ...changes } = row;
    return ResultAsync.fromPromise(
      db
        .insert(factorySettings)
        .values(row)
        .onConflictDoUpdate({
          target: [factorySettings.projectId, factorySettings.userId],
          set: changes,
        }),
      storage,
    ).map(() => toView(row));
  };

  return {
    get(
      userId: string,
      projectId: string,
    ): ResultAsync<FactorySettingsView | null, FactorySettingsError> {
      return requireProjectAccess(userId, projectId, 'view', accessErrors).andThen(() =>
        find(userId, projectId),
      );
    },

    /** The caller's factory row id for a project, or null — used to list its runs. */
    factoryId(userId: string, projectId: string): ResultAsync<string | null, FactorySettingsError> {
      return requireProjectAccess(userId, projectId, 'view', accessErrors).andThen(() =>
        ResultAsync.fromPromise(
          db
            .select({ id: factorySettings.id })
            .from(factorySettings)
            .where(byOwner(userId, projectId)),
          storage,
        ).map(([row]) => row?.id ?? null),
      );
    },

    save(
      userId: string,
      projectId: string,
      input: SaveFactorySettingsInput,
    ): ResultAsync<FactorySettingsView, FactorySettingsError> {
      const invalid = validate(input);
      if (invalid) return errAsync(invalid);
      // Enabling a factory starts agent threads on the project as this user,
      // so it needs the same capability as starting a thread by hand.
      return requireProjectAccess(userId, projectId, 'steer', accessErrors)
        .andThen(() => find(userId, projectId))
        .andThen((existing) => upsert(buildRow(deps.newId(), userId, projectId, input, existing)));
    },
  };
}
