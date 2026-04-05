/**
 * @domain subdomain: Memory System (Paisley Park)
 * @domain subdomain-type: core
 * @domain type: app-service
 * @domain layer: application
 *
 * Garbage collection for memory maintenance.
 * Handles: decay sweep, semantic dedup, orphan cleanup,
 * and index rebuild verification.
 */

import { Result, err, ok } from 'neverthrow';

import { getPaisleyPark } from './index.js';
import { log } from './logger.js';
import { listFacts, updateFact, deleteFact, syncDb } from './storage.js';
import { calculateDecayScore, cosineSimilarity } from './temporal.js';
import { DEFAULT_GC_CONFIG, type GCConfig, type StorageConfig } from './types.js';

// ─── GC result ─────────────────────────────────────────

export interface GCResult {
  archived: number;
  deduped: number;
  consolidated: number;
  orphaned: number;
  indexRebuilt: boolean;
}

// ─── Main GC runner ────────────────────────────────────

export async function runGC(
  config: StorageConfig,
  gcConfig: GCConfig = DEFAULT_GC_CONFIG,
): Promise<Result<GCResult, string>> {
  const pp = getPaisleyPark(config);
  await pp.init();

  const db = pp.getDb();
  const projectId = config.projectId;
  const result: GCResult = {
    archived: 0,
    deduped: 0,
    consolidated: 0,
    orphaned: 0,
    indexRebuilt: false,
  };

  log.info('Starting GC run', { namespace: 'memory:gc', projectId });

  // 1. Decay sweep — invalidate facts below threshold
  const factsResult = await listFacts(db, projectId);
  if (factsResult.isErr()) return err(factsResult.error);

  const now = new Date();
  for (const fact of factsResult.value) {
    const score = calculateDecayScore(fact, now);
    if (score < gcConfig.decayThreshold) {
      await updateFact(db, fact.id, {
        invalid_at: now.toISOString(),
        invalidated_by: `gc:decay (score=${score.toFixed(4)})`,
      });
      result.archived++;
    }
  }

  // 2. Orphan cleanup — invalidate fast-decay facts with no recent access
  const cutoffMs = gcConfig.orphanDays * 86_400_000;
  for (const fact of factsResult.value) {
    if (fact.invalidAt !== null) continue;
    if (fact.decayClass !== 'fast') continue;

    const lastAccess = new Date(fact.lastAccessed);
    if (now.getTime() - lastAccess.getTime() > cutoffMs) {
      await updateFact(db, fact.id, {
        invalid_at: now.toISOString(),
        invalidated_by: `gc:orphan (${gcConfig.orphanDays}d no access)`,
      });
      result.orphaned++;
    }
  }

  // 3. Semantic dedup (requires embedding provider)
  const embeddingProvider = pp.getEmbeddingProvider();
  if (embeddingProvider.dimensions() > 0) {
    const activeFacts = factsResult.value.filter((f) => f.invalidAt === null);
    if (activeFacts.length >= 2) {
      try {
        const embeddings = await embeddingProvider.embedBatch(activeFacts.map((f) => f.content));
        const deduped = new Set<string>();

        for (let i = 0; i < activeFacts.length; i++) {
          if (deduped.has(activeFacts[i].id)) continue;

          for (let j = i + 1; j < activeFacts.length; j++) {
            if (deduped.has(activeFacts[j].id)) continue;

            const sim = cosineSimilarity(embeddings[i], embeddings[j]);
            if (sim >= gcConfig.dedupThreshold) {
              const older = activeFacts[j];
              const newer = activeFacts[i];

              // Link newer to older, then invalidate older
              const newRelated = [...new Set([...JSON.parse('[]'), older.id])];
              await updateFact(db, newer.id, {
                related: JSON.stringify([...newer.related, older.id]),
              });
              await updateFact(db, older.id, {
                invalid_at: now.toISOString(),
                superseded_by: newer.id,
                invalidated_by: `gc:dedup (sim=${sim.toFixed(4)})`,
              });

              deduped.add(older.id);
              result.deduped++;
            }
          }
        }
      } catch (e) {
        log.warn(`Semantic dedup failed: ${e}`, { namespace: 'memory:gc' });
      }
    }
  }

  // 4. Index rebuild verification
  const vectorIndex = pp.getVectorIndex();
  if (vectorIndex.isAvailable()) {
    const activeResult = await listFacts(db, projectId);
    if (activeResult.isOk()) {
      const fileCount = activeResult.value.length;
      const indexCount = await vectorIndex.getFactCount();
      const discrepancy = Math.abs(fileCount - indexCount) / Math.max(fileCount, 1);

      if (discrepancy > gcConfig.indexRebuildThreshold) {
        log.info('Vector index discrepancy, rebuilding', {
          namespace: 'memory:gc',
          fileCount,
          indexCount,
        });

        const rebuildResult = await vectorIndex.rebuild(
          activeResult.value.map((f) => ({ id: f.id, content: f.content })),
        );
        result.indexRebuilt = rebuildResult.isOk();
      }
    }
  }

  // Sync after GC
  await syncDb(db);

  log.info('GC run completed', { namespace: 'memory:gc', projectId, result });
  return ok(result);
}

// ─── GC trigger logic ──────────────────────────────────

let lastGCRun: Date | null = null;
let threadsSinceGC = 0;

export function trackThreadCompletion() {
  threadsSinceGC++;
}

export function shouldRunGC(interval: number = 10): boolean {
  if (threadsSinceGC >= interval) return true;
  if (!lastGCRun) return true;
  const hoursSinceGC = (Date.now() - lastGCRun.getTime()) / 3_600_000;
  return hoursSinceGC >= 24;
}

export function markGCComplete() {
  lastGCRun = new Date();
  threadsSinceGC = 0;
}
