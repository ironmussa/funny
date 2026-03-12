/**
 * @domain subdomain: Memory System (Paisley Park)
 * @domain subdomain-type: core
 * @domain type: infrastructure-service
 * @domain layer: infrastructure
 *
 * SQLite-vec backed vector index for semantic search.
 * Stored in .index/vectors.db within the memory directory.
 * Rebuilt from filesystem if lost — filesystem is source of truth.
 */

import { Database } from 'bun:sqlite';
import { existsSync } from 'fs';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

import { Result, err, ok } from 'neverthrow';

import { log } from './logger.js';
import type { EmbeddingProvider } from './types.js';

// ─── Index metadata ─────────────────────────────────────

interface IndexMeta {
  modelId: string;
  dimensions: number;
  factCount: number;
  lastRebuilt: string;
}

// ─── Vector index ───────────────────────────────────────

export class VectorIndex {
  private db: Database | null = null;
  private meta: IndexMeta | null = null;
  private vecExtensionLoaded = false;

  constructor(
    private readonly memoryDir: string,
    private readonly provider: EmbeddingProvider,
  ) {}

  private get dbPath(): string {
    return join(this.memoryDir, '.index', 'vectors.db');
  }

  private get metaPath(): string {
    return join(this.memoryDir, '.index', 'meta.json');
  }

  // ─── Initialization ─────────────────────────────────

  async init(): Promise<Result<void, string>> {
    try {
      const dims = this.provider.dimensions();
      if (dims === 0) {
        // Null provider — no vector search available
        log.info('Vector index disabled (null embedding provider)', { namespace: 'memory' });
        return ok(undefined);
      }

      // Check if model changed
      if (existsSync(this.metaPath)) {
        try {
          const raw = await readFile(this.metaPath, 'utf-8');
          this.meta = JSON.parse(raw);
          if (this.meta!.modelId !== this.provider.modelId()) {
            log.info('Embedding model changed, will rebuild index', {
              namespace: 'memory',
              old: this.meta!.modelId,
              new: this.provider.modelId(),
            });
            this.meta = null; // Force rebuild
          }
        } catch {
          this.meta = null;
        }
      }

      this.db = new Database(this.dbPath);

      // Try to load sqlite-vec extension
      try {
        const sqliteVec = require('sqlite-vec');
        sqliteVec.load(this.db);
        this.vecExtensionLoaded = true;
      } catch (e) {
        log.warn('sqlite-vec extension not available — using fallback cosine search', {
          namespace: 'memory',
          error: String(e),
        });
      }

      if (this.vecExtensionLoaded) {
        // Create virtual table with vec0
        this.db.exec(`
          CREATE VIRTUAL TABLE IF NOT EXISTS vec_facts USING vec0(
            fact_id TEXT PRIMARY KEY,
            embedding float[${dims}]
          )
        `);
      } else {
        // Fallback: regular table with blob storage
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS fact_embeddings (
            fact_id TEXT PRIMARY KEY,
            embedding BLOB NOT NULL
          )
        `);
      }

      // Save metadata if new
      if (!this.meta) {
        this.meta = {
          modelId: this.provider.modelId(),
          dimensions: dims,
          factCount: 0,
          lastRebuilt: new Date().toISOString(),
        };
        await this.saveMeta();
      }

      return ok(undefined);
    } catch (e) {
      return err(`Failed to initialize vector index: ${e}`);
    }
  }

  // ─── CRUD operations ────────────────────────────────

  async addVector(factId: string, text: string): Promise<Result<void, string>> {
    if (!this.db || this.provider.dimensions() === 0) return ok(undefined);

    try {
      const embedding = await this.provider.embed(text);

      if (this.vecExtensionLoaded) {
        this.db.run('INSERT OR REPLACE INTO vec_facts(fact_id, embedding) VALUES(?, ?)', [
          factId,
          new Uint8Array(embedding.buffer),
        ]);
      } else {
        this.db.run('INSERT OR REPLACE INTO fact_embeddings(fact_id, embedding) VALUES(?, ?)', [
          factId,
          new Uint8Array(embedding.buffer),
        ]);
      }

      if (this.meta) {
        this.meta.factCount++;
        await this.saveMeta();
      }

      return ok(undefined);
    } catch (e) {
      return err(`Failed to add vector for ${factId}: ${e}`);
    }
  }

  removeVector(factId: string): Result<void, string> {
    if (!this.db) return ok(undefined);

    try {
      if (this.vecExtensionLoaded) {
        this.db.run('DELETE FROM vec_facts WHERE fact_id = ?', [factId]);
      } else {
        this.db.run('DELETE FROM fact_embeddings WHERE fact_id = ?', [factId]);
      }
      return ok(undefined);
    } catch (e) {
      return err(`Failed to remove vector for ${factId}: ${e}`);
    }
  }

  async searchSimilar(
    query: string,
    topK: number = 10,
  ): Promise<Result<Array<{ factId: string; score: number }>, string>> {
    if (!this.db || this.provider.dimensions() === 0) return ok([]);

    try {
      const queryEmbedding = await this.provider.embed(query);

      if (this.vecExtensionLoaded) {
        const rows = this.db
          .query(
            `SELECT fact_id, distance
             FROM vec_facts
             WHERE embedding MATCH ?
             ORDER BY distance
             LIMIT ?`,
          )
          .all(new Uint8Array(queryEmbedding.buffer), topK) as Array<{
          fact_id: string;
          distance: number;
        }>;

        return ok(
          rows.map((r) => ({
            factId: r.fact_id,
            // vec0 returns L2 distance — convert to similarity score (higher is better)
            score: 1 / (1 + r.distance),
          })),
        );
      } else {
        // Fallback: load all embeddings and compute cosine similarity in JS
        const rows = this.db
          .query('SELECT fact_id, embedding FROM fact_embeddings')
          .all() as Array<{ fact_id: string; embedding: Uint8Array }>;

        const results = rows
          .map((r) => {
            const emb = new Float32Array(r.embedding.buffer);
            const score = cosineSim(queryEmbedding, emb);
            return { factId: r.fact_id, score };
          })
          .sort((a, b) => b.score - a.score)
          .slice(0, topK);

        return ok(results);
      }
    } catch (e) {
      return err(`Vector search failed: ${e}`);
    }
  }

  // ─── Full rebuild ───────────────────────────────────

  async rebuild(facts: Array<{ id: string; content: string }>): Promise<Result<number, string>> {
    if (!this.db || this.provider.dimensions() === 0) return ok(0);

    try {
      // Clear existing
      if (this.vecExtensionLoaded) {
        this.db.exec('DELETE FROM vec_facts');
      } else {
        this.db.exec('DELETE FROM fact_embeddings');
      }

      let indexed = 0;
      // Batch embed in chunks of 32
      const BATCH_SIZE = 32;
      for (let i = 0; i < facts.length; i += BATCH_SIZE) {
        const batch = facts.slice(i, i + BATCH_SIZE);
        const embeddings = await this.provider.embedBatch(batch.map((f) => f.content));

        for (let j = 0; j < batch.length; j++) {
          const blob = new Uint8Array(embeddings[j].buffer);
          if (this.vecExtensionLoaded) {
            this.db.run('INSERT OR REPLACE INTO vec_facts(fact_id, embedding) VALUES(?, ?)', [
              batch[j].id,
              blob,
            ]);
          } else {
            this.db.run('INSERT OR REPLACE INTO fact_embeddings(fact_id, embedding) VALUES(?, ?)', [
              batch[j].id,
              blob,
            ]);
          }
          indexed++;
        }
      }

      this.meta = {
        modelId: this.provider.modelId(),
        dimensions: this.provider.dimensions(),
        factCount: indexed,
        lastRebuilt: new Date().toISOString(),
      };
      await this.saveMeta();

      return ok(indexed);
    } catch (e) {
      return err(`Index rebuild failed: ${e}`);
    }
  }

  // ─── Metadata ───────────────────────────────────────

  getFactCount(): number {
    if (!this.db) return 0;
    try {
      if (this.vecExtensionLoaded) {
        const row = this.db.query('SELECT count(*) as c FROM vec_facts').get() as any;
        return row?.c ?? 0;
      } else {
        const row = this.db.query('SELECT count(*) as c FROM fact_embeddings').get() as any;
        return row?.c ?? 0;
      }
    } catch {
      return 0;
    }
  }

  isAvailable(): boolean {
    return this.db !== null && this.provider.dimensions() > 0;
  }

  close() {
    this.db?.close();
    this.db = null;
  }

  // ─── Private ────────────────────────────────────────

  private async saveMeta() {
    if (this.meta) {
      await writeFile(this.metaPath, JSON.stringify(this.meta, null, 2));
    }
  }
}

// ─── Utility ────────────────────────────────────────────

function cosineSim(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}
