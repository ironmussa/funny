/**
 * @domain subdomain: Memory System (Paisley Park)
 * @domain subdomain-type: core
 * @domain type: infrastructure-service
 * @domain layer: infrastructure
 *
 * libSQL-backed storage for memory facts.
 * Supports local SQLite (file:path) and remote sync (libsql://host)
 * via embedded replicas.
 */

import type { Client, InValue } from '@libsql/client';
import { createClient } from '@libsql/client';
import { Result, err, ok } from 'neverthrow';

import { log } from './logger.js';
import type { EmbeddingProvider, FactRow, MemoryFact, StorageConfig } from './types.js';
import { rowToFact } from './types.js';

// ─── Schema ────────────────────────────────────────────

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS facts (
    id              TEXT PRIMARY KEY,
    type            TEXT NOT NULL,
    content         TEXT NOT NULL,
    confidence      REAL NOT NULL DEFAULT 0.8,
    source_agent    TEXT,
    source_operator TEXT,
    source_session  TEXT,
    valid_from      TEXT NOT NULL,
    invalid_at      TEXT,
    ingested_at     TEXT NOT NULL,
    invalidated_by  TEXT,
    superseded_by   TEXT,
    tags            TEXT NOT NULL DEFAULT '[]',
    related         TEXT NOT NULL DEFAULT '[]',
    decay_class     TEXT NOT NULL DEFAULT 'normal',
    access_count    INTEGER NOT NULL DEFAULT 0,
    last_accessed   TEXT NOT NULL,
    project_id      TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_facts_project
    ON facts(project_id);

  CREATE INDEX IF NOT EXISTS idx_facts_type
    ON facts(project_id, type);

  CREATE INDEX IF NOT EXISTS idx_facts_valid
    ON facts(project_id, invalid_at);

  CREATE INDEX IF NOT EXISTS idx_facts_ingested
    ON facts(project_id, ingested_at);

  CREATE TABLE IF NOT EXISTS fact_embeddings (
    fact_id   TEXT PRIMARY KEY REFERENCES facts(id) ON DELETE CASCADE,
    embedding BLOB NOT NULL
  );

  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

// ─── Database connection ───────────────────────────────

export function createDb(config: StorageConfig): Client {
  const clientConfig: Parameters<typeof createClient>[0] = {
    url: config.url,
  };

  if (config.syncUrl) {
    clientConfig.syncUrl = config.syncUrl;
    clientConfig.authToken = config.authToken;
    if (config.syncInterval) {
      clientConfig.syncInterval = config.syncInterval;
    }
  } else if (config.authToken) {
    clientConfig.authToken = config.authToken;
  }

  return createClient(clientConfig);
}

export async function initSchema(db: Client): Promise<Result<void, string>> {
  try {
    const statements = SCHEMA_SQL.split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    for (const sql of statements) {
      await db.execute(sql);
    }

    return ok(undefined);
  } catch (e) {
    return err(`Failed to initialize schema: ${e}`);
  }
}

// ─── Sync helper ───────────────────────────────────────

export async function syncDb(db: Client): Promise<void> {
  try {
    if ('sync' in db && typeof (db as any).sync === 'function') {
      await (db as any).sync();
    }
  } catch {
    // sync not available (non-replica client) — ignore
  }
}

// ─── Fact CRUD ─────────────────────────────────────────

export async function insertFact(db: Client, fact: MemoryFact): Promise<Result<void, string>> {
  try {
    await db.execute({
      sql: `INSERT OR REPLACE INTO facts
            (id, type, content, confidence, source_agent, source_operator, source_session,
             valid_from, invalid_at, ingested_at, invalidated_by, superseded_by,
             tags, related, decay_class, access_count, last_accessed, project_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        fact.id,
        fact.type,
        fact.content,
        fact.confidence,
        fact.sourceAgent,
        fact.sourceOperator,
        fact.sourceSession,
        fact.validFrom,
        fact.invalidAt,
        fact.ingestedAt,
        fact.invalidatedBy,
        fact.supersededBy,
        JSON.stringify(fact.tags),
        JSON.stringify(fact.related),
        fact.decayClass,
        fact.accessCount,
        fact.lastAccessed,
        fact.projectId,
      ],
    });
    return ok(undefined);
  } catch (e) {
    return err(`Failed to insert fact ${fact.id}: ${e}`);
  }
}

export async function getFact(db: Client, factId: string): Promise<Result<MemoryFact, string>> {
  try {
    const result = await db.execute({
      sql: 'SELECT * FROM facts WHERE id = ?',
      args: [factId],
    });
    if (result.rows.length === 0) return err(`Fact not found: ${factId}`);
    return ok(rowToFact(result.rows[0] as unknown as FactRow));
  } catch (e) {
    return err(`Failed to get fact ${factId}: ${e}`);
  }
}

export async function updateFact(
  db: Client,
  factId: string,
  updates: Partial<Record<string, InValue>>,
): Promise<Result<void, string>> {
  const keys = Object.keys(updates);
  if (keys.length === 0) return ok(undefined);

  const setClauses = keys.map((k) => `${k} = ?`).join(', ');
  const values = keys.map((k) => updates[k]!);

  try {
    await db.execute({
      sql: `UPDATE facts SET ${setClauses} WHERE id = ?`,
      args: [...values, factId],
    });
    return ok(undefined);
  } catch (e) {
    return err(`Failed to update fact ${factId}: ${e}`);
  }
}

export async function listFacts(
  db: Client,
  projectId: string,
  options: {
    includeInvalidated?: boolean;
    type?: string;
    limit?: number;
  } = {},
): Promise<Result<MemoryFact[], string>> {
  try {
    const conditions = ['project_id = ?'];
    const args: InValue[] = [projectId];

    if (!options.includeInvalidated) {
      conditions.push('invalid_at IS NULL');
    }
    if (options.type) {
      conditions.push('type = ?');
      args.push(options.type);
    }

    let sql = `SELECT * FROM facts WHERE ${conditions.join(' AND ')} ORDER BY ingested_at DESC`;
    if (options.limit) {
      sql += ` LIMIT ?`;
      args.push(options.limit);
    }

    const result = await db.execute({ sql, args });
    return ok(result.rows.map((r) => rowToFact(r as unknown as FactRow)));
  } catch (e) {
    return err(`Failed to list facts: ${e}`);
  }
}

export async function deleteFact(db: Client, factId: string): Promise<Result<void, string>> {
  try {
    await db.execute({ sql: 'DELETE FROM facts WHERE id = ?', args: [factId] });
    return ok(undefined);
  } catch (e) {
    return err(`Failed to delete fact ${factId}: ${e}`);
  }
}

// ─── Embedding storage ─────────────────────────────────

export async function upsertEmbedding(
  db: Client,
  factId: string,
  embedding: Float32Array,
): Promise<Result<void, string>> {
  try {
    await db.execute({
      sql: 'INSERT OR REPLACE INTO fact_embeddings (fact_id, embedding) VALUES (?, ?)',
      args: [factId, new Uint8Array(embedding.buffer)],
    });
    return ok(undefined);
  } catch (e) {
    return err(`Failed to upsert embedding for ${factId}: ${e}`);
  }
}

export async function deleteEmbedding(db: Client, factId: string): Promise<Result<void, string>> {
  try {
    await db.execute({ sql: 'DELETE FROM fact_embeddings WHERE fact_id = ?', args: [factId] });
    return ok(undefined);
  } catch (e) {
    return err(`Failed to delete embedding for ${factId}: ${e}`);
  }
}

export async function getAllEmbeddings(
  db: Client,
): Promise<Result<Array<{ factId: string; embedding: Float32Array }>, string>> {
  try {
    const result = await db.execute('SELECT fact_id, embedding FROM fact_embeddings');
    return ok(
      result.rows.map((r) => ({
        factId: r.fact_id as string,
        embedding: new Float32Array(r.embedding as ArrayBuffer),
      })),
    );
  } catch (e) {
    return err(`Failed to get embeddings: ${e}`);
  }
}

// ─── Meta key-value ────────────────────────────────────

export async function getMeta(db: Client, key: string): Promise<string | null> {
  try {
    const result = await db.execute({ sql: 'SELECT value FROM meta WHERE key = ?', args: [key] });
    return result.rows.length > 0 ? (result.rows[0].value as string) : null;
  } catch {
    return null;
  }
}

export async function setMeta(db: Client, key: string, value: string): Promise<void> {
  await db.execute({
    sql: 'INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)',
    args: [key, value],
  });
}

// ─── Helpers ───────────────────────────────────────────

export function generateFactId(): string {
  const now = new Date();
  const date = now.toISOString().split('T')[0];
  const rand = Math.random().toString(36).slice(2, 6);
  return `fact-${date}-${rand}`;
}
