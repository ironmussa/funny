/**
 * @domain subdomain: Memory System (Paisley Park)
 * @domain subdomain-type: core
 * @domain type: app-service
 * @domain layer: application
 *
 * Garbage collection agent for memory maintenance.
 * Handles: decay sweep, semantic dedup, context consolidation,
 * orphan cleanup, and index rebuild verification.
 */

import { Result, err, ok } from 'neverthrow';

import { getPaisleyPark } from './index.js';
import { log } from './logger.js';
import { listFacts, moveFact, readFact, regenerateIndex, writeFact, gitCommit } from './storage.js';
import { calculateDecayScore, cosineSimilarity } from './temporal.js';
import {
  DEFAULT_GC_CONFIG,
  frontmatterToApi,
  type GCConfig,
  type MemoryFactFile,
} from './types.js';

// ─── GC result ──────────────────────────────────────────

export interface GCResult {
  archived: number;
  deduped: number;
  consolidated: number;
  orphaned: number;
  indexRebuilt: boolean;
}

// ─── Main GC runner ─────────────────────────────────────

export async function runGC(
  projectId: string,
  projectName: string,
  config: GCConfig = DEFAULT_GC_CONFIG,
): Promise<Result<GCResult, string>> {
  const pp = getPaisleyPark(projectId, projectName);
  const initResult = await pp.init();
  if (initResult.isErr()) return err(initResult.error);

  const memoryDir = pp.memoryDir;
  const result: GCResult = {
    archived: 0,
    deduped: 0,
    consolidated: 0,
    orphaned: 0,
    indexRebuilt: false,
  };

  log.info('Starting GC run', { namespace: 'memory:gc', projectId });

  // 1. Decay sweep
  const decayResult = await decaySweep(memoryDir, config.decayThreshold);
  if (decayResult.isOk()) {
    result.archived = decayResult.value;
    if (result.archived > 0) {
      gitCommit(memoryDir, `memory(gc): archive ${result.archived} facts below decay threshold`);
    }
  }

  // 2. Orphan cleanup
  const orphanResult = await orphanCleanup(memoryDir, config.orphanDays);
  if (orphanResult.isOk()) {
    result.orphaned = orphanResult.value;
    if (result.orphaned > 0) {
      gitCommit(memoryDir, `memory(gc): archive ${result.orphaned} orphaned fast-decay facts`);
    }
  }

  // 3. Semantic dedup (requires embedding provider)
  const embeddingProvider = pp.getEmbeddingProvider();
  if (embeddingProvider.dimensions() > 0) {
    const dedupResult = await semanticDedup(memoryDir, embeddingProvider, config.dedupThreshold);
    if (dedupResult.isOk()) {
      result.deduped = dedupResult.value;
      if (result.deduped > 0) {
        gitCommit(memoryDir, `memory(gc): merge ${result.deduped} duplicate facts`);
      }
    }

    // 4. Context consolidation
    const consolidateResult = await contextConsolidation(
      memoryDir,
      embeddingProvider,
      config.consolidationThreshold,
      config.consolidationMinCluster,
    );
    if (consolidateResult.isOk()) {
      result.consolidated = consolidateResult.value;
      if (result.consolidated > 0) {
        gitCommit(
          memoryDir,
          `memory(gc): consolidate ${result.consolidated} context facts into insights`,
        );
      }
    }
  }

  // 5. Index rebuild verification
  const vectorIndex = pp.getVectorIndex();
  if (vectorIndex.isAvailable()) {
    const factsResult = await listFacts(memoryDir);
    if (factsResult.isOk()) {
      const fileCount = factsResult.value.filter((f) => f.frontmatter.invalid_at === null).length;
      const indexCount = vectorIndex.getFactCount();
      const discrepancy = Math.abs(fileCount - indexCount) / Math.max(fileCount, 1);

      if (discrepancy > config.indexRebuildThreshold) {
        log.info('Vector index discrepancy detected, rebuilding', {
          namespace: 'memory:gc',
          fileCount,
          indexCount,
          discrepancy: `${(discrepancy * 100).toFixed(1)}%`,
        });

        const rebuildResult = await vectorIndex.rebuild(
          factsResult.value
            .filter((f) => f.frontmatter.invalid_at === null)
            .map((f) => ({ id: f.frontmatter.id, content: f.content })),
        );
        result.indexRebuilt = rebuildResult.isOk();
      }
    }
  }

  // Regenerate INDEX.md after all GC actions
  await regenerateIndex(memoryDir);

  log.info('GC run completed', { namespace: 'memory:gc', projectId, result });
  return ok(result);
}

// ─── Decay sweep ────────────────────────────────────────

async function decaySweep(memoryDir: string, threshold: number): Promise<Result<number, string>> {
  const factsResult = await listFacts(memoryDir);
  if (factsResult.isErr()) return err(factsResult.error);

  let archived = 0;
  const now = new Date();

  for (const fact of factsResult.value) {
    if (fact.frontmatter.invalid_at !== null) continue; // already invalidated

    const score = calculateDecayScore(fact.frontmatter, now);
    if (score < threshold) {
      const toPath = fact.relativePath.replace('project/facts/', 'project/archive/');
      const moveResult = await moveFact(memoryDir, fact.relativePath, toPath);
      if (moveResult.isOk()) archived++;
    }
  }

  return ok(archived);
}

// ─── Orphan cleanup ─────────────────────────────────────

async function orphanCleanup(
  memoryDir: string,
  orphanDays: number,
): Promise<Result<number, string>> {
  const factsResult = await listFacts(memoryDir);
  if (factsResult.isErr()) return err(factsResult.error);

  let archived = 0;
  const now = new Date();
  const cutoff = orphanDays * 86_400_000;

  for (const fact of factsResult.value) {
    if (fact.frontmatter.invalid_at !== null) continue;
    if (fact.frontmatter.decay_class !== 'fast') continue;

    const lastAccess = new Date(fact.frontmatter.last_accessed);
    if (now.getTime() - lastAccess.getTime() > cutoff) {
      const toPath = fact.relativePath.replace('project/facts/', 'project/archive/');
      const moveResult = await moveFact(memoryDir, fact.relativePath, toPath);
      if (moveResult.isOk()) archived++;
    }
  }

  return ok(archived);
}

// ─── Semantic dedup ─────────────────────────────────────

async function semanticDedup(
  memoryDir: string,
  embeddingProvider: any,
  threshold: number,
): Promise<Result<number, string>> {
  const factsResult = await listFacts(memoryDir);
  if (factsResult.isErr()) return err(factsResult.error);

  const activeFacts = factsResult.value.filter((f) => f.frontmatter.invalid_at === null);
  if (activeFacts.length < 2) return ok(0);

  try {
    const embeddings = await embeddingProvider.embedBatch(activeFacts.map((f) => f.content));
    const deduped = new Set<string>();
    let mergeCount = 0;

    for (let i = 0; i < activeFacts.length; i++) {
      if (deduped.has(activeFacts[i].frontmatter.id)) continue;

      for (let j = i + 1; j < activeFacts.length; j++) {
        if (deduped.has(activeFacts[j].frontmatter.id)) continue;

        const sim = cosineSimilarity(embeddings[i], embeddings[j]);
        if (sim >= threshold) {
          // Keep the newer one, invalidate the older
          const older = activeFacts[j];
          const newer = activeFacts[i];

          // Update newer to reference older
          newer.frontmatter.related.push(older.frontmatter.id);
          await writeFact(memoryDir, newer.relativePath, newer.frontmatter, newer.content);

          // Invalidate older
          older.frontmatter.invalid_at = new Date().toISOString();
          older.frontmatter.superseded_by = newer.frontmatter.id;
          await writeFact(memoryDir, older.relativePath, older.frontmatter, older.content);

          deduped.add(older.frontmatter.id);
          mergeCount++;
        }
      }
    }

    return ok(mergeCount);
  } catch (e) {
    return err(`Semantic dedup failed: ${e}`);
  }
}

// ─── Context consolidation ──────────────────────────────

async function contextConsolidation(
  memoryDir: string,
  embeddingProvider: any,
  threshold: number,
  minCluster: number,
): Promise<Result<number, string>> {
  const factsResult = await listFacts(memoryDir);
  if (factsResult.isErr()) return err(factsResult.error);

  const contextFacts = factsResult.value.filter(
    (f) => f.frontmatter.type === 'context' && f.frontmatter.invalid_at === null,
  );

  if (contextFacts.length < minCluster) return ok(0);

  // For now, simple consolidation: find clusters of similar context facts
  // and log them. Full LLM-based consolidation is a future enhancement.
  log.info(`Context consolidation: ${contextFacts.length} context facts eligible`, {
    namespace: 'memory:gc',
  });

  return ok(0); // Placeholder — full implementation requires LLM summarization
}

// ─── GC trigger logic ───────────────────────────────────

let lastGCRun: Date | null = null;
let threadsSinceGC = 0;

export function trackThreadCompletion() {
  threadsSinceGC++;
}

export function shouldRunGC(interval: number = 10): boolean {
  // Run after N thread completions
  if (threadsSinceGC >= interval) return true;

  // Run on startup if >24h since last GC
  if (!lastGCRun) return true;
  const hoursSinceGC = (Date.now() - lastGCRun.getTime()) / 3_600_000;
  return hoursSinceGC >= 24;
}

export function markGCComplete() {
  lastGCRun = new Date();
  threadsSinceGC = 0;
}
