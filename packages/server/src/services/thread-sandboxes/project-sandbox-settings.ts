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
import { projectSandboxSettings } from '../../db/schema.js';
import { requireProjectAccess as sharedRequireProjectAccess } from '../project-access.js';
import type { InfraConnectionService } from './infra-connections.js';

/** Where a user's new threads run on a project. `sandbox` uses the connection/size. */
export type ThreadRuntimeMode = 'local' | 'worktree' | 'sandbox';

export interface ProjectSandboxView {
  projectId: string;
  connectionId: string;
  sizeId: string;
  mode: ThreadRuntimeMode;
  updatedAt: string;
}

export type ProjectSandboxError =
  /** The project is not the caller's, or the connection is not theirs. */
  | { kind: 'not-found'; message: string }
  /** The caller can see the project but their role does not allow this. */
  | { kind: 'forbidden'; message: string }
  | { kind: 'invalid-size'; message: string }
  /** The connection exists but cannot be used (undecryptable, bad config). */
  | { kind: 'connection'; message: string }
  | { kind: 'storage'; message: string };

export interface SaveProjectSandboxInput {
  mode: ThreadRuntimeMode;
  /** Required when mode is 'sandbox'; ignored (but preserved) for local/worktree. */
  connectionId?: string;
  sizeId?: string;
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
  mode: row.mode as ThreadRuntimeMode,
  updatedAt: row.updatedAt,
});

const byOwner = (userId: string, projectId: string) =>
  and(eq(projectSandboxSettings.projectId, projectId), eq(projectSandboxSettings.userId, userId));

const accessErrors = {
  storage,
  notFound: (): ProjectSandboxError => ({ kind: 'not-found', message: 'Project not found' }),
  forbidden: (): ProjectSandboxError => ({
    kind: 'forbidden',
    message: 'Choosing where threads run needs contributor access to the project',
  }),
};

/**
 * The runtime is per-user: anyone who can see the project reads their own row,
 * and anyone who may start threads on it (`steer`) writes it. A viewer cannot
 * start threads, so their runtime choice would never be used.
 */
const requireProjectAccess = (userId: string, projectId: string, capability: 'view' | 'steer') =>
  sharedRequireProjectAccess(userId, projectId, capability, accessErrors);

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
      return requireProjectAccess(userId, projectId, 'view').andThen(() => find(userId, projectId));
    },

    save(
      userId: string,
      projectId: string,
      input: SaveProjectSandboxInput,
    ): ResultAsync<ProjectSandboxView, ProjectSandboxError> {
      const persist = (
        connectionId: string,
        sizeId: string,
      ): ResultAsync<ProjectSandboxView, ProjectSandboxError> => {
        const row: Row = {
          projectId,
          userId,
          connectionId,
          sizeId,
          mode: input.mode,
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
      };

      return requireProjectAccess(userId, projectId, 'steer').andThen(() => {
        // sandbox: the connection must be the caller's and the size must exist.
        if (input.mode === 'sandbox') {
          if (!input.connectionId) {
            return errAsync<ProjectSandboxView, ProjectSandboxError>({
              kind: 'not-found',
              message: 'A sandbox connection is required',
            });
          }
          const connectionId = input.connectionId;
          return resolveSize(userId, connectionId, input.sizeId).andThen((sizeId) =>
            persist(connectionId, sizeId),
          );
        }
        // local / worktree: no connection validation; keep the last sandbox
        // connection/size (or a sentinel) so the NOT NULL columns stay filled.
        return find(userId, projectId).andThen((existing) =>
          persist(
            input.connectionId ?? existing?.connectionId ?? '',
            input.sizeId ?? existing?.sizeId ?? '',
          ),
        );
      });
    },

    clear(userId: string, projectId: string): ResultAsync<void, ProjectSandboxError> {
      return requireProjectAccess(userId, projectId, 'steer').andThen(() =>
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
