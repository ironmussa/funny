/**
 * Host seam for the database (docs/plans/cloudflare-portability.md, Phase 1):
 * a host installs its own provider, or scopes one to an async context (one
 * connection per request); `db` and transactions follow the active one.
 */
import { afterEach, describe, expect, test } from 'bun:test';

import type { DatabaseProvider, DbDialect } from '@funny/shared/db/connection';

import * as database from '../../db/index.js';

/** A provider whose `db` exposes a marker and records transactions. */
function fakeProvider(name: string, dialect: DbDialect = 'sqlite') {
  const transactions: string[] = [];
  const provider: DatabaseProvider = {
    db: {
      marker: name,
      transaction: async (work: (tx: unknown) => Promise<unknown>) => {
        transactions.push(name);
        return work({ marker: `${name}-tx` });
      },
    },
    schema: {},
    dialect,
    rawDriver: null,
    close: async () => {},
  };
  return { provider, transactions };
}

const marker = () => (database.db as unknown as { marker: string }).marker;

afterEach(() => database.resetDatabaseForTests());

describe('useDatabaseProvider', () => {
  test('db reads the installed provider and dbDialect follows it', () => {
    database.useDatabaseProvider(fakeProvider('global', 'pg').provider);
    expect(marker()).toBe('global');
    expect(database.dbDialect).toBe('pg');
  });

  test('db throws before any provider is installed', () => {
    expect(() => marker()).toThrow(/not initialized/);
  });
});

describe('runWithDatabase', () => {
  test('scopes a provider to its async context and falls back outside it', async () => {
    database.useDatabaseProvider(fakeProvider('global').provider);
    const scoped = fakeProvider('request-a').provider;

    const inside = await database.runWithDatabase(scoped, async () => {
      await Promise.resolve();
      return marker();
    });

    expect(inside).toBe('request-a');
    expect(marker()).toBe('global');
  });

  test('concurrent requests each see their own provider', async () => {
    database.useDatabaseProvider(fakeProvider('global').provider);
    const seen: string[] = [];
    const run = (name: string, delayMs: number) =>
      database.runWithDatabase(fakeProvider(name).provider, async () => {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        seen.push(`${name}:${marker()}`);
      });

    await Promise.all([run('slow', 20), run('fast', 1)]);

    expect(seen.sort()).toEqual(['fast:fast', 'slow:slow']);
  });

  test('works without a process-wide provider', () => {
    expect(database.runWithDatabase(fakeProvider('only').provider, marker)).toBe('only');
  });

  test('refuses a provider whose dialect differs from the instance dialect', () => {
    database.useDatabaseProvider(fakeProvider('global', 'sqlite').provider);
    expect(() => database.runWithDatabase(fakeProvider('pg', 'pg').provider, marker)).toThrow(
      /does not match/,
    );
  });

  test('transactions inside use the scoped provider', async () => {
    const global = fakeProvider('global', 'pg');
    const request = fakeProvider('request', 'pg');
    database.useDatabaseProvider(global.provider);

    const inTx = await database.runWithDatabase(request.provider, () =>
      database.withDatabaseTransaction(async () => marker()),
    );

    expect(inTx).toBe('request-tx');
    expect(request.transactions).toEqual(['request']);
    expect(global.transactions).toEqual([]);
  });
});
