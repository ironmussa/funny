import type { ProjectSecretSummary } from '@funny/shared/contracts/project-secrets';
/**
 * @domain subdomain: Projects
 * @domain subdomain-type: supporting
 * @domain type: application-service
 * @domain layer: application
 *
 * Project secrets (openspec `project-secrets`): named values stored encrypted
 * and handed to the project's agents as environment variables. A secret is
 * either shared by the project (`scope = 'project'`, needs `manage` to change)
 * or one member's own (`scope = 'user'`, needs `steer`).
 *
 * A value goes in through `set` and comes out only through
 * `resolveThreadSecrets`, the single reader of decrypted values, which answers
 * the runner that runs a thread. No other method returns a value.
 */
import { errorMessage } from '@funny/shared/errors';
import {
  SECRET_MAX_PER_SCOPE,
  secretNameMessage,
  secretValueMessage,
  validateSecretName,
  validateSecretValue,
  type ProjectSecretScope,
  type SecretValue,
} from '@funny/shared/project-secrets';
import { and, eq, or } from 'drizzle-orm';
import { ResultAsync, errAsync, okAsync } from 'neverthrow';

import { db } from '../db/index.js';
import { projectSecrets, threads } from '../db/schema.js';
import { audit } from '../lib/audit.js';
import * as keyring from '../lib/crypto.js';
import { log } from '../lib/logger.js';
import { requireProjectAccess, type ProjectAccessErrors } from './project-access.js';
import { sandboxThreadOfRunner } from './runner-scope.js';

export type ProjectSecretError =
  | { kind: 'not-found'; message: string }
  | { kind: 'forbidden'; message: string }
  | { kind: 'invalid'; message: string }
  | { kind: 'storage'; message: string };

export type SecretDeliveryError =
  /** The asking runner may not have this thread's secrets. */
  | { kind: 'refused'; message: string }
  /** A stored value cannot be decrypted; `secretName` says which. */
  | { kind: 'undecryptable'; message: string; secretName: string }
  | { kind: 'storage'; message: string };

export interface SetProjectSecret {
  projectId: string;
  scope: ProjectSecretScope;
  name: string;
  /** Left out to keep the stored value (only for a secret that exists). */
  value?: string;
  allowInSandbox: boolean;
}

export interface ProjectSecretsDeps {
  newId: () => string;
  now: () => Date;
  crypto: Pick<typeof keyring, 'encrypt' | 'decrypt' | 'isEncryptedWithActiveKey'>;
  sandboxThreadOfRunner: (runnerId: string) => Promise<string | null>;
}

type Row = typeof projectSecrets.$inferSelect;

type StorageFailure = Extract<ProjectSecretError, { kind: 'storage' }>;

const storage = (cause: unknown): StorageFailure => ({
  kind: 'storage',
  message: errorMessage(cause),
});

const accessErrors = (forbidden: string): ProjectAccessErrors<ProjectSecretError> => ({
  storage,
  notFound: () => ({ kind: 'not-found', message: 'Project not found' }),
  forbidden: () => ({ kind: 'forbidden', message: forbidden }),
});

const invalid = (message: string): ProjectSecretError => ({ kind: 'invalid', message });

const toSummary = (row: Row): ProjectSecretSummary => ({
  id: row.id,
  name: row.name,
  scope: row.scope === 'user' ? 'user' : 'project',
  allowInSandbox: row.allowInSandbox === 1,
  updatedBy: row.updatedBy,
  updatedAt: row.updatedAt,
});

/** Shared rows carry `user_id = ''`, so the unique index also covers them. */
const ownerOf = (scope: ProjectSecretScope, userId: string) => (scope === 'user' ? userId : '');

const inScope = (projectId: string, scope: ProjectSecretScope, userId: string) =>
  and(
    eq(projectSecrets.projectId, projectId),
    eq(projectSecrets.scope, scope),
    eq(projectSecrets.userId, ownerOf(scope, userId)),
  );

/** The project's shared rows plus `userId`'s own. */
const visibleTo = (projectId: string, userId: string) =>
  and(
    eq(projectSecrets.projectId, projectId),
    or(
      eq(projectSecrets.scope, 'project'),
      and(eq(projectSecrets.scope, 'user'), eq(projectSecrets.userId, userId)),
    ),
  );

/** What changing a secret of this scope needs: shared ones are an admin's. */
const writeAccess = (scope: ProjectSecretScope) =>
  scope === 'project'
    ? ({
        capability: 'manage',
        message: 'Changing a shared secret needs admin access to the project',
      } as const)
    : ({
        capability: 'steer',
        message: 'Keeping personal secrets needs contributor access to the project',
      } as const);

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

export function createProjectSecretsService(overrides: Partial<ProjectSecretsDeps> = {}) {
  const deps: ProjectSecretsDeps = {
    newId: () => crypto.randomUUID(),
    now: () => new Date(),
    crypto: keyring,
    sandboxThreadOfRunner,
    ...overrides,
  };

  const select = (where: ReturnType<typeof and>) =>
    ResultAsync.fromPromise(db.select().from(projectSecrets).where(where), storage);

  function validate(input: SetProjectSecret): ProjectSecretError | null {
    const nameProblem = validateSecretName(input.name);
    if (nameProblem) return invalid(secretNameMessage(nameProblem));
    if (input.value !== undefined) {
      const valueProblem = validateSecretValue(input.value);
      if (valueProblem) return invalid(secretValueMessage(valueProblem));
    }
    return null;
  }

  /** The row a save writes: a new one, or `existing` with its changes. */
  function rowToSave(
    userId: string,
    input: SetProjectSecret,
    existing: Row | undefined,
    ciphertext: string,
  ): Row {
    const now = deps.now().toISOString();
    const changes = { ciphertext, allowInSandbox: input.allowInSandbox ? 1 : 0, updatedBy: userId };
    if (existing) return { ...existing, ...changes, updatedAt: now };
    return {
      id: deps.newId(),
      projectId: input.projectId,
      scope: input.scope,
      userId: ownerOf(input.scope, userId),
      name: input.name,
      ...changes,
      createdAt: now,
      updatedAt: now,
    };
  }

  /** Insert, or on conflict change the sandbox setting and (when given) the value. */
  function upsert(userId: string, input: SetProjectSecret, existing: Row | undefined) {
    const ciphertext =
      input.value !== undefined ? deps.crypto.encrypt(input.value) : existing?.ciphertext;
    if (ciphertext === undefined) {
      return errAsync<Row, ProjectSecretError>(invalid('A new secret needs a value.'));
    }
    const row = rowToSave(userId, input, existing, ciphertext);
    return ResultAsync.fromPromise(
      db
        .insert(projectSecrets)
        .values(row)
        .onConflictDoUpdate({
          target: [
            projectSecrets.projectId,
            projectSecrets.scope,
            projectSecrets.userId,
            projectSecrets.name,
          ],
          set: {
            allowInSandbox: row.allowInSandbox,
            updatedBy: row.updatedBy,
            updatedAt: row.updatedAt,
            ...(input.value !== undefined && { ciphertext }),
          },
        }),
      storage,
    ).map(() => row);
  }

  /** Decrypt every row or fail naming the first that cannot be read. */
  function decryptAll(rows: Row[]): ResultAsync<SecretValue[], SecretDeliveryError> {
    const values: SecretValue[] = [];
    for (const row of rows) {
      const value = deps.crypto.decrypt(row.ciphertext);
      if (value === null) {
        return errAsync({
          kind: 'undecryptable',
          secretName: row.name,
          message: `The project secret ${row.name} cannot be decrypted. Save it again or delete it in the project settings.`,
        });
      }
      values.push({ name: row.name, value });
    }
    return okAsync(values);
  }

  /** Move rows read with an older key to the active one (lazy, best effort). */
  async function upgradeKeys(rows: Row[], values: SecretValue[]): Promise<void> {
    for (const [index, row] of rows.entries()) {
      if (deps.crypto.isEncryptedWithActiveKey(row.ciphertext)) continue;
      try {
        await db
          .update(projectSecrets)
          .set({ ciphertext: deps.crypto.encrypt(values[index].value) })
          .where(and(eq(projectSecrets.id, row.id), eq(projectSecrets.ciphertext, row.ciphertext)));
      } catch (error) {
        log.warn('Could not re-encrypt a project secret with the active key', {
          namespace: 'project-secrets',
          secretId: row.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return {
    /** The project's shared secrets and the caller's own: names and settings, no values. */
    list(
      userId: string,
      projectId: string,
    ): ResultAsync<ProjectSecretSummary[], ProjectSecretError> {
      return requireProjectAccess(
        userId,
        projectId,
        'view',
        accessErrors('Not allowed to see this project'),
      )
        .andThen(() => select(visibleTo(projectId, userId)))
        .map((rows) => rows.map(toSummary).sort(byName));
    },

    /** Create a secret, or change the one with this name and scope. */
    set(
      userId: string,
      input: SetProjectSecret,
    ): ResultAsync<ProjectSecretSummary, ProjectSecretError> {
      const problem = validate(input);
      if (problem) return errAsync(problem);
      const access = writeAccess(input.scope);
      return requireProjectAccess(
        userId,
        input.projectId,
        access.capability,
        accessErrors(access.message),
      )
        .andThen(() => select(inScope(input.projectId, input.scope, userId)))
        .andThen((rows) => {
          const existing = rows.find((row) => row.name === input.name);
          if (!existing && rows.length >= SECRET_MAX_PER_SCOPE) {
            return errAsync<Row, ProjectSecretError>(
              invalid(`A project holds at most ${SECRET_MAX_PER_SCOPE} secrets per scope.`),
            );
          }
          return upsert(userId, input, existing);
        })
        .map((row) => {
          audit({
            action: 'secret.set',
            actorId: userId,
            detail: `Project secret ${row.name} saved`,
            meta: {
              projectId: row.projectId,
              secretName: row.name,
              scope: row.scope,
              allowInSandbox: row.allowInSandbox === 1,
              valueChanged: input.value !== undefined,
            },
          });
          return toSummary(row);
        });
    },

    /** Delete a secret. A personal one must be the caller's own. */
    remove(userId: string, projectId: string, id: string): ResultAsync<void, ProjectSecretError> {
      const missing: ProjectSecretError = { kind: 'not-found', message: 'Secret not found' };
      return requireProjectAccess(
        userId,
        projectId,
        'view',
        accessErrors('Not allowed to see this project'),
      )
        .andThen(() => select(and(visibleTo(projectId, userId), eq(projectSecrets.id, id))))
        .andThen(([row]) => {
          if (!row) return errAsync<Row, ProjectSecretError>(missing);
          const access = writeAccess(row.scope === 'user' ? 'user' : 'project');
          return requireProjectAccess(
            userId,
            projectId,
            access.capability,
            accessErrors(access.message),
          ).map(() => row);
        })
        .andThen((row) =>
          ResultAsync.fromPromise(
            db.delete(projectSecrets).where(eq(projectSecrets.id, row.id)),
            storage,
          ).map(() => {
            audit({
              action: 'secret.delete',
              actorId: userId,
              detail: `Project secret ${row.name} deleted`,
              meta: { projectId, secretName: row.name, scope: row.scope },
            });
          }),
        );
    },

    /**
     * What the agent of `threadId` receives, for the runner that asks. The data
     * scope already checked that the runner may serve the thread's project;
     * this adds that the runner is the thread owner's, or the thread's own
     * sandbox. The THREAD OWNER selects the personal secrets, so a steer
     * sharee's follow-up, an automation and a factory run get what the owner's
     * own message would.
     */
    resolveThreadSecrets(request: {
      threadId: string;
      runnerId: string;
      runnerOwnerId: string;
    }): ResultAsync<SecretValue[], SecretDeliveryError> {
      const { threadId, runnerId, runnerOwnerId } = request;
      const refuse = (reason: string) => {
        audit({
          action: 'secret.delivery_refused',
          actorId: runnerOwnerId,
          detail: `Project secrets refused: ${reason}`,
          meta: { threadId, runnerId },
        });
        return errAsync<Row[], SecretDeliveryError>({ kind: 'refused', message: reason });
      };

      let sandbox = false;
      let delivered: Row[] = [];
      return ResultAsync.fromPromise(
        Promise.all([
          db
            .select({ projectId: threads.projectId, userId: threads.userId })
            .from(threads)
            .where(eq(threads.id, threadId)),
          deps.sandboxThreadOfRunner(runnerId),
        ]),
        storage,
      )
        .andThen(([[thread], boundThread]) => {
          if (!thread) return refuse('thread not found');
          if (boundThread !== null) {
            if (boundThread !== threadId) return refuse('thread outside sandbox runner scope');
            sandbox = true;
          } else if (thread.userId !== runnerOwnerId) {
            return refuse('runner does not belong to the thread owner');
          }
          // Scratch threads have no project, hence no secrets.
          if (!thread.projectId) return okAsync<Row[], SecretDeliveryError>([]);
          return select(visibleTo(thread.projectId, thread.userId));
        })
        .andThen((rows) => {
          // A personal row takes the place of the shared row of its name; only
          // then does the sandbox setting decide, so a personal row that is off
          // also hides the shared value.
          const chosen = new Map<string, Row>();
          for (const row of rows) if (row.scope !== 'user') chosen.set(row.name, row);
          for (const row of rows) if (row.scope === 'user') chosen.set(row.name, row);
          delivered = [...chosen.values()]
            .filter((row) => !sandbox || row.allowInSandbox === 1)
            // A name that became reserved after it was saved is not delivered.
            .filter((row) => validateSecretName(row.name) === null)
            .sort(byName);
          return decryptAll(delivered);
        })
        .map((values) => {
          if (values.length > 0) {
            void upgradeKeys(delivered, values);
            audit({
              action: 'secret.delivered',
              actorId: runnerOwnerId,
              detail: `${values.length} project secret(s) delivered for an agent start`,
              meta: { threadId, runnerId, sandbox, secretNames: values.map((v) => v.name) },
            });
          }
          return values;
        });
    },
  };
}

export type ProjectSecretsService = ReturnType<typeof createProjectSecretsService>;

let shared: ProjectSecretsService | undefined;

/** The process-wide service, for callers with nothing to inject. */
export function projectSecretsService(): ProjectSecretsService {
  shared ??= createProjectSecretsService();
  return shared;
}
