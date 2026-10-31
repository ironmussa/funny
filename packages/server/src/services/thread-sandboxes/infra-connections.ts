/**
 * @domain subdomain: Runner Infrastructure
 * @domain subdomain-type: supporting
 * @domain type: application-service
 * @domain layer: application
 *
 * Users' credentials for sandbox providers (change thread-sandboxes).
 *
 * A credential is validated against its provider before it is stored, kept
 * encrypted at rest (`lib/crypto`), and never returned to the client or
 * written to logs. Every read is scoped to the owning user.
 */

import { and, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { errAsync, okAsync, ResultAsync } from 'neverthrow';

import { db } from '../../db/index.js';
import { infraConnections } from '../../db/schema.js';
import { decrypt, encrypt } from '../../lib/crypto.js';
import type { SandboxError, SandboxProvider } from './contract.js';
import type { SandboxProviderRegistry } from './registry.js';

export interface InfraConnectionView {
  id: string;
  provider: string;
  label: string;
  accountLabel: string | null;
  createdAt: string;
  lastValidatedAt: string | null;
}

export type InfraConnectionError =
  | { kind: 'unknown-provider'; message: string }
  | { kind: 'invalid-config'; message: string }
  /** The provider refused the credential (or the account cannot be used). */
  | { kind: 'rejected'; message: string; cause: SandboxError['kind'] }
  | { kind: 'not-found'; message: string }
  | { kind: 'storage'; message: string };

type Row = typeof infraConnections.$inferSelect;

const storage = (error: unknown): InfraConnectionError => ({
  kind: 'storage',
  message: error instanceof Error ? error.message : String(error),
});

const toView = (row: Row): InfraConnectionView => ({
  id: row.id,
  provider: row.provider,
  label: row.label,
  accountLabel: row.accountLabel ?? null,
  createdAt: row.createdAt,
  lastValidatedAt: row.lastValidatedAt ?? null,
});

export function createInfraConnectionService(registry: SandboxProviderRegistry) {
  const instantiate = (provider: string, credential: string, config: unknown) =>
    registry
      .instantiate({ providerId: provider, credential, config })
      .mapErr((error): InfraConnectionError =>
        error.kind === 'invalid-config'
          ? { kind: 'invalid-config', message: error.message }
          : { kind: 'unknown-provider', message: `unknown provider ${error.providerId}` },
      );

  const validate = (provider: SandboxProvider) =>
    provider.validate().mapErr((error): InfraConnectionError => ({
      kind: 'rejected',
      message: error.message,
      cause: error.kind,
    }));

  const ownedRow = (userId: string, id: string): ResultAsync<Row, InfraConnectionError> =>
    ResultAsync.fromPromise(
      db
        .select()
        .from(infraConnections)
        .where(and(eq(infraConnections.id, id), eq(infraConnections.userId, userId))),
      storage,
    ).andThen(([row]) =>
      row
        ? okAsync<Row, InfraConnectionError>(row)
        : errAsync<Row, InfraConnectionError>({ kind: 'not-found', message: id }),
    );

  const providerFromRow = (row: Row): ResultAsync<SandboxProvider, InfraConnectionError> => {
    const credential = decrypt(row.credentialEnc);
    if (credential === null) {
      return errAsync({ kind: 'storage', message: 'connection credential cannot be decrypted' });
    }
    let config: unknown = {};
    try {
      config = JSON.parse(row.configJson);
    } catch {
      return errAsync({ kind: 'invalid-config', message: 'stored config is not valid JSON' });
    }
    const provider = instantiate(row.provider, credential, config);
    return provider.isOk() ? okAsync(provider.value) : errAsync(provider.error);
  };

  return {
    /** Validate with the provider, then store the credential encrypted. */
    add(
      userId: string,
      input: { provider: string; label: string; credential: string; config?: unknown },
    ): ResultAsync<InfraConnectionView, InfraConnectionError> {
      const provider = instantiate(input.provider, input.credential, input.config ?? {});
      if (provider.isErr()) return errAsync(provider.error);
      return validate(provider.value).andThen(({ accountLabel }) => {
        const now = new Date().toISOString();
        const row: Row = {
          id: nanoid(),
          userId,
          provider: input.provider,
          label: input.label,
          configJson: JSON.stringify(input.config ?? {}),
          credentialEnc: encrypt(input.credential),
          accountLabel,
          createdAt: now,
          lastValidatedAt: now,
        };
        return ResultAsync.fromPromise(db.insert(infraConnections).values(row), storage).map(() =>
          toView(row),
        );
      });
    },

    list(userId: string): ResultAsync<InfraConnectionView[], InfraConnectionError> {
      return ResultAsync.fromPromise(
        db.select().from(infraConnections).where(eq(infraConnections.userId, userId)),
        storage,
      ).map((rows) => rows.map(toView));
    },

    remove(userId: string, id: string): ResultAsync<void, InfraConnectionError> {
      return ownedRow(userId, id).andThen(() =>
        ResultAsync.fromPromise(
          db
            .delete(infraConnections)
            .where(and(eq(infraConnections.id, id), eq(infraConnections.userId, userId))),
          storage,
        ).map(() => undefined),
      );
    },

    /** Re-validate a stored credential and record when it last worked. */
    test(userId: string, id: string): ResultAsync<InfraConnectionView, InfraConnectionError> {
      return ownedRow(userId, id).andThen((row) =>
        providerFromRow(row)
          .andThen(validate)
          .andThen(({ accountLabel }) => {
            const lastValidatedAt = new Date().toISOString();
            return ResultAsync.fromPromise(
              db
                .update(infraConnections)
                .set({ accountLabel, lastValidatedAt })
                .where(eq(infraConnections.id, id)),
              storage,
            ).map(() => toView({ ...row, accountLabel, lastValidatedAt }));
          }),
      );
    },

    /** Server-internal: a live provider client for the user's connection. */
    providerFor(
      userId: string,
      id: string,
    ): ResultAsync<{ connectionId: string; provider: SandboxProvider }, InfraConnectionError> {
      return ownedRow(userId, id).andThen((row) =>
        providerFromRow(row).map((provider) => ({ connectionId: row.id, provider })),
      );
    },
  };
}

export type InfraConnectionService = ReturnType<typeof createInfraConnectionService>;
