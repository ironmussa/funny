/**
 * @domain subdomain: Runner Infrastructure
 * @domain subdomain-type: supporting
 * @domain type: application-service
 * @domain layer: application
 *
 * Each user's sandbox for a project (change project-sandboxes): which of their
 * own provider connections new threads use, at what size, and whether the
 * composer starts with the sandbox on. Every read and write is scoped to the
 * calling user and to a project they own; the connection is checked against
 * its owner and the size against the provider's declared sizes.
 */

import { resolveSandboxSize } from '@funny/sandbox';
import { and, eq } from 'drizzle-orm';
import { errAsync, okAsync, ResultAsync } from 'neverthrow';

import { db } from '../../db/index.js';
import { projects, projectSandboxSettings } from '../../db/schema.js';
import type { InfraConnectionService } from './infra-connections.js';

export interface ProjectSandboxView {
  projectId: string;
  connectionId: string;
  sizeId: string;
  enabledByDefault: boolean;
  updatedAt: string;
}

export type ProjectSandboxError =
  /** The project is not the caller's, or the connection is not theirs. */
  | { kind: 'not-found'; message: string }
  | { kind: 'invalid-size'; message: string }
  /** The connection exists but cannot be used (undecryptable, bad config). */
  | { kind: 'connection'; message: string }
  | { kind: 'storage'; message: string };

export interface SaveProjectSandboxInput {
  connectionId: string;
  sizeId?: string;
  enabledByDefault: boolean;
}

type Row = typeof projectSandboxSettings.$inferSelect;

const storage = (error: unknown): ProjectSandboxError => ({
  kind: 'storage',
  message: error instanceof Error ? error.message : String(error),
});

const toView = (row: Row): ProjectSandboxView => ({
  projectId: row.projectId,
  connectionId: row.connectionId,
  sizeId: row.sizeId,
  enabledByDefault: row.enabledByDefault === 1,
  updatedAt: row.updatedAt,
});

const byOwner = (userId: string, projectId: string) =>
  and(eq(projectSandboxSettings.projectId, projectId), eq(projectSandboxSettings.userId, userId));

/** Refuses a project the caller does not own, as not found. */
function requireOwnedProject(
  userId: string,
  projectId: string,
): ResultAsync<void, ProjectSandboxError> {
  return ResultAsync.fromPromise(
    db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.userId, userId))),
    storage,
  ).andThen(([row]) =>
    row
      ? okAsync<void, ProjectSandboxError>(undefined)
      : errAsync<void, ProjectSandboxError>({ kind: 'not-found', message: 'Project not found' }),
  );
}

export function createProjectSandboxSettingsService(
  connections: Pick<InfraConnectionService, 'providerFor'>,
) {
  /** The size to store: the requested one if the connection's provider offers it. */
  const resolveSize = (
    userId: string,
    connectionId: string,
    requested: string | undefined,
  ): ResultAsync<string, ProjectSandboxError> =>
    connections
      .providerFor(userId, connectionId)
      .mapErr((error): ProjectSandboxError =>
        error.kind === 'not-found'
          ? { kind: 'not-found', message: 'Connection not found' }
          : error.kind === 'storage'
            ? { kind: 'storage', message: error.message }
            : { kind: 'connection', message: error.message },
      )
      .andThen(({ provider }) => {
        const size = resolveSandboxSize(provider.capabilities(), requested);
        return size
          ? okAsync<string, ProjectSandboxError>(size.id)
          : errAsync<string, ProjectSandboxError>({
              kind: 'invalid-size',
              message: `${provider.id} has no size ${requested}`,
            });
      });

  /** The caller's sandbox for a project, or null when none is configured. */
  const find = (userId: string, projectId: string) =>
    ResultAsync.fromPromise(
      db.select().from(projectSandboxSettings).where(byOwner(userId, projectId)),
      storage,
    ).map(([row]) => (row ? toView(row) : null));

  return {
    get(
      userId: string,
      projectId: string,
    ): ResultAsync<ProjectSandboxView | null, ProjectSandboxError> {
      return requireOwnedProject(userId, projectId).andThen(() => find(userId, projectId));
    },

    save(
      userId: string,
      projectId: string,
      input: SaveProjectSandboxInput,
    ): ResultAsync<ProjectSandboxView, ProjectSandboxError> {
      return requireOwnedProject(userId, projectId)
        .andThen(() => resolveSize(userId, input.connectionId, input.sizeId))
        .andThen((sizeId) => {
          const row: Row = {
            projectId,
            userId,
            connectionId: input.connectionId,
            sizeId,
            enabledByDefault: input.enabledByDefault ? 1 : 0,
            updatedAt: new Date().toISOString(),
          };
          const { projectId: _p, userId: _u, ...changes } = row;
          return ResultAsync.fromPromise(
            db
              .insert(projectSandboxSettings)
              .values(row)
              .onConflictDoUpdate({
                target: [projectSandboxSettings.projectId, projectSandboxSettings.userId],
                set: changes,
              }),
            storage,
          ).map(() => toView(row));
        });
    },

    clear(userId: string, projectId: string): ResultAsync<void, ProjectSandboxError> {
      return requireOwnedProject(userId, projectId).andThen(() =>
        ResultAsync.fromPromise(
          db.delete(projectSandboxSettings).where(byOwner(userId, projectId)),
          storage,
        ).map(() => undefined),
      );
    },

    /**
     * Server-internal, for sandbox thread creation: the caller's configuration
     * for a project. Ownership of the project is checked by the launcher.
     */
    forThread(
      userId: string,
      projectId: string,
    ): ResultAsync<ProjectSandboxView | null, ProjectSandboxError> {
      return find(userId, projectId);
    },
  };
}
