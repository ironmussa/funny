/**
 * @domain subdomain: Memory System (Paisley Park)
 * @domain subdomain-type: core
 * @domain type: infrastructure-service
 * @domain layer: infrastructure
 *
 * Vector search integrated into the same libSQL database.
 * Stores embeddings in fact_embeddings table, performs cosine
 * similarity search in JS (brute-force over the table).
 *
 * When the dataset grows beyond ~10k facts, consider migrating
 * to sqlite-vec virtual tables for native ANN search.
 */

import type { Client } from '@libsql/client';
import { Result, err, ok } from 'neverthrow';

import { log } from './logger.js';
import { deleteEmbedding, getAllEmbeddings, getMeta, setMeta, upsertEmbedding } from './storage.js';
import type { EmbeddingProvider } from './types.js';

// ─── Vector index ──────────────────────────────────────

export class VectorIndex {
  constructor(
    private readonly db: Client,
    private readonly provider: EmbeddingProvider,
  ) {}

  // ─── CRUD ──────────────────────────────────────────

  async addVector(factId: string, text: string): Promise<Result<void, string>> {
    if (this.provider.dimensions() === 0) return ok(undefined);

    try {
      const embedding = await this.provider.embed(text);
      return upsertEmbedding(this.db, factId, embedding);
    } catch (e) {
      return err(`Failed to add vector for ${factId}: ${e}`);
    }
  }

  removeVector(factId: string): Promise<Result<void, string>> {
    return deleteEmbedding(this.db, factId);
  }

  async searchSimilar(
    query: string,
    topK: number = 10,
  ): Promise<Result<Array<{ factId: string; score: number }>, string>> {
    if (this.provider.dimensions() === 0) return ok([]);

    try {
      const queryEmbedding = await this.provider.embed(query);
      const allResult = await getAllEmbeddings(this.db);
      if (allResult.isErr()) return err(allResult.error);

      const results = allResult.value
        .map((r) => ({
          factId: r.factId,
          score: cosineSim(queryEmbedding, r.embedding),
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);

      return ok(results);
    } catch (e) {
      return err(`Vector search failed: ${e}`);
    }
  }

  // ─── Rebuild ───────────────────────────────────────

  async rebuild(facts: Array<{ id: string; content: string }>): Promise<Result<number, string>> {
    if (this.provider.dimensions() === 0) return ok(0);

    try {
      // Clear existing embeddings
      await this.db.execute('DELETE FROM fact_embeddings');

      let indexed = 0;
      const BATCH_SIZE = 32;

      for (let i = 0; i < facts.length; i += BATCH_SIZE) {
        const batch = facts.slice(i, i + BATCH_SIZE);
        const embeddings = await this.provider.embedBatch(batch.map((f) => f.content));

        for (let j = 0; j < batch.length; j++) {
          await upsertEmbedding(this.db, batch[j].id, embeddings[j]);
          indexed++;
        }
      }

      await setMeta(this.db, 'embedding_model', this.provider.modelId());
      await setMeta(this.db, 'embedding_dimensions', String(this.provider.dimensions()));
      await setMeta(this.db, 'last_rebuilt', new Date().toISOString());

      return ok(indexed);
    } catch (e) {
      return err(`Index rebuild failed: ${e}`);
    }
  }

  // ─── Check if model changed ────────────────────────

  async needsRebuild(): Promise<boolean> {
    if (this.provider.dimensions() === 0) return false;
    const storedModel = await getMeta(this.db, 'embedding_model');
    if (!storedModel) return true;
    return storedModel !== this.provider.modelId();
  }

  // ─── Metadata ──────────────────────────────────────

  async getFactCount(): Promise<number> {
    try {
      const result = await this.db.execute('SELECT count(*) as c FROM fact_embeddings');
      return (result.rows[0]?.c as number) ?? 0;
    } catch {
      return 0;
    }
  }

  isAvailable(): boolean {
    return this.provider.dimensions() > 0;
  }
}

// ─── Cosine similarity ─────────────────────────────────

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
