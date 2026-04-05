/**
 * @domain subdomain: Memory System (Paisley Park)
 * @domain type: app-service
 * @domain layer: application
 *
 * LLM-powered memory consolidation agent.
 * Runs inside PaisleyPark, calls api-acp for intelligent tasks.
 * Uses a distributed lock (in the meta table) so only one instance
 * consolidates at a time across a team.
 */

import type { Client } from '@libsql/client';

import type { LLMConfig } from './llm.js';
import { llmComplete } from './llm.js';
import { log } from './logger.js';
import {
  getMeta,
  insertFact,
  generateFactId,
  listFacts,
  setMeta,
  syncDb,
  updateFact,
} from './storage.js';
import { cosineSimilarity } from './temporal.js';
import type { EmbeddingProvider, MemoryFact } from './types.js';

// ─── Result ────────────────────────────────────────────

export interface ConsolidationResult {
  clustersConsolidated: number;
  factsInvalidated: number;
  factsCreated: number;
  lockAcquired: boolean;
}

// ─── System prompts ────────────────────────────────────

const CONSOLIDATION_PROMPT = `You are a memory consolidation agent for a software project.

Given a cluster of related memory facts, produce a SINGLE consolidated fact that:
- Merges overlapping information into one concise statement
- Resolves contradictions by keeping the newest information
- Converts relative dates to absolute dates when possible
- Removes information derivable from code (file paths, function signatures, git history)
- Maximum 3 sentences
- Preserve the most important technical details

Return ONLY the consolidated text. No preamble, no explanation.`;

const ADMISSION_PROMPT = `You are a memory admission filter for a software project.

Determine if this fact contains information that is DERIVABLE by reading code, running git commands, or checking file structure. Derivable information includes:
- File/directory structure or paths
- Function signatures, class definitions, import statements
- Git history, blame, commit messages, PR details
- Test results, build output, error stack traces
- Package versions from package.json/lockfiles

Answer with ONLY "REJECT" if the fact is derivable, or "ACCEPT" if it contains genuine knowledge that cannot be derived from code.`;

// ─── Distributed lock ──────────────────────────────────

const LOCK_KEY = 'consolidation_lock';
const LOCK_TTL_MS = 5 * 60_000; // 5 minutes

interface LockData {
  holder: string;
  expires: number;
}

function lockHolder(): string {
  return `${process.env.HOSTNAME ?? 'local'}-${process.pid}-${Date.now()}`;
}

async function acquireLock(db: Client): Promise<boolean> {
  const holder = lockHolder();
  const expires = Date.now() + LOCK_TTL_MS;
  const lockValue = JSON.stringify({ holder, expires } satisfies LockData);

  // Try to acquire: insert if missing, or update if expired
  const existing = await getMeta(db, LOCK_KEY);
  if (existing) {
    try {
      const data = JSON.parse(existing) as LockData;
      if (data.expires > Date.now()) {
        // Lock is held and not expired
        return false;
      }
    } catch {
      // Corrupt lock data — overwrite
    }
  }

  await setMeta(db, LOCK_KEY, lockValue);

  // Re-read to confirm we won (handles race between two instances)
  const confirm = await getMeta(db, LOCK_KEY);
  if (confirm) {
    try {
      const data = JSON.parse(confirm) as LockData;
      return data.holder === holder;
    } catch {
      return false;
    }
  }
  return false;
}

async function releaseLock(db: Client): Promise<void> {
  await db.execute({ sql: 'DELETE FROM meta WHERE key = ?', args: [LOCK_KEY] });
}

// ─── Main consolidation ───────────────────────────────

export async function runConsolidation(
  db: Client,
  projectId: string,
  llm: LLMConfig,
  embeddingProvider: EmbeddingProvider,
  similarityThreshold: number = 0.8,
  minClusterSize: number = 3,
): Promise<ConsolidationResult> {
  const result: ConsolidationResult = {
    clustersConsolidated: 0,
    factsInvalidated: 0,
    factsCreated: 0,
    lockAcquired: false,
  };

  // 1. Acquire distributed lock
  const locked = await acquireLock(db);
  if (!locked) {
    log.info('Consolidation skipped — another instance holds the lock', {
      namespace: 'memory:consolidator',
    });
    return result;
  }
  result.lockAcquired = true;

  log.info('Consolidation started', { namespace: 'memory:consolidator', projectId });

  try {
    // 2. Load active facts
    const factsResult = await listFacts(db, projectId);
    if (factsResult.isErr() || factsResult.value.length < minClusterSize) {
      return result;
    }
    const facts = factsResult.value;

    // 3. Find clusters of similar facts
    if (embeddingProvider.dimensions() === 0) {
      log.info('No embedding provider — skipping cluster detection', {
        namespace: 'memory:consolidator',
      });
      return result;
    }

    const embeddings = await embeddingProvider.embedBatch(facts.map((f) => f.content));
    const clusters = findClusters(facts, embeddings, similarityThreshold, minClusterSize);

    log.info(`Found ${clusters.length} clusters to consolidate`, {
      namespace: 'memory:consolidator',
    });

    // 4. Consolidate each cluster via LLM
    for (const cluster of clusters) {
      try {
        const consolidated = await consolidateCluster(llm, cluster);
        if (!consolidated) continue;

        // Create new consolidated fact
        const now = new Date().toISOString();
        const newFact: MemoryFact = {
          id: generateFactId(),
          type: inferConsolidatedType(cluster),
          content: consolidated,
          confidence: Math.max(...cluster.map((f) => f.confidence)),
          sourceAgent: 'paisley-park:consolidator',
          sourceOperator: null,
          sourceSession: null,
          validFrom: earliest(cluster.map((f) => f.validFrom)),
          invalidAt: null,
          ingestedAt: now,
          invalidatedBy: null,
          supersededBy: null,
          tags: mergedTags(cluster),
          related: cluster.map((f) => f.id),
          decayClass: cluster[0].decayClass,
          accessCount: 0,
          lastAccessed: now,
          projectId,
        };

        await insertFact(db, newFact);
        result.factsCreated++;

        // Invalidate originals
        for (const fact of cluster) {
          await updateFact(db, fact.id, {
            invalid_at: now,
            superseded_by: newFact.id,
            invalidated_by: 'consolidation',
          });
          result.factsInvalidated++;
        }

        result.clustersConsolidated++;

        log.info(`Consolidated cluster of ${cluster.length} facts → ${newFact.id}`, {
          namespace: 'memory:consolidator',
          originalIds: cluster.map((f) => f.id),
        });
      } catch (e) {
        log.warn(`Failed to consolidate cluster: ${e}`, {
          namespace: 'memory:consolidator',
          clusterSize: cluster.length,
        });
      }
    }

    // Sync after all consolidation
    await syncDb(db);

    // Record last consolidation time
    await setMeta(db, 'last_consolidation', new Date().toISOString());
  } finally {
    await releaseLock(db);
  }

  log.info('Consolidation completed', { namespace: 'memory:consolidator', result });
  return result;
}

// ─── Admission filter ──────────────────────────────────

export async function checkAdmission(
  llm: LLMConfig,
  content: string,
): Promise<{ admitted: boolean; reason?: string }> {
  // Fast path: regex patterns for obviously derivable content
  if (DERIVABLE_PATTERNS.some((p) => p.test(content))) {
    return { admitted: false, reason: 'content matches derivable pattern' };
  }

  // LLM check for ambiguous cases
  try {
    const response = await llmComplete(llm, content, ADMISSION_PROMPT);
    const decision = response.trim().toUpperCase();

    if (decision.startsWith('REJECT')) {
      return { admitted: false, reason: 'LLM classified as derivable' };
    }
    return { admitted: true };
  } catch {
    // If LLM is unavailable, admit by default (fail open)
    return { admitted: true };
  }
}

const DERIVABLE_PATTERNS = [
  /^(the )?(file|directory|folder) (structure|tree|layout)/i,
  /^(the )?git (log|history|blame|diff|status)/i,
  /^(function|class|method|interface|type|const|let|var|export) \w+/i,
  /^(PR|pull request|merge request|commit) #?\d+/i,
  /^(test|build|lint|ci) (passed|failed|succeeded|error)/i,
  /^(npm|bun|yarn|pnpm) (install|run|test|build)/i,
  /^(the )?stack trace/i,
  /^(error|warning|info):\s/i,
  /^import \{/,
  /^(packages|src|lib|node_modules)\//,
];

// ─── Trigger logic ─────────────────────────────────────

const CONSOLIDATION_INTERVAL_HOURS = 6;
const CONSOLIDATION_THREAD_THRESHOLD = 10;

let threadsSinceConsolidation = 0;

export function trackCompletion(): void {
  threadsSinceConsolidation++;
}

export async function shouldConsolidate(db: Client): Promise<boolean> {
  if (threadsSinceConsolidation >= CONSOLIDATION_THREAD_THRESHOLD) return true;

  const lastRun = await getMeta(db, 'last_consolidation');
  if (!lastRun) return true;

  const hoursSince = (Date.now() - new Date(lastRun).getTime()) / 3_600_000;
  return hoursSince >= CONSOLIDATION_INTERVAL_HOURS;
}

export function markConsolidated(): void {
  threadsSinceConsolidation = 0;
}

// ─── Private helpers ───────────────────────────────────

async function consolidateCluster(llm: LLMConfig, facts: MemoryFact[]): Promise<string | null> {
  const factsBlock = facts
    .map((f) => `[${f.id}] (${f.ingestedAt}, type: ${f.type}): ${f.content}`)
    .join('\n\n');

  const prompt = `Consolidate these ${facts.length} related memory facts:\n\n${factsBlock}`;

  const response = await llmComplete(llm, prompt, CONSOLIDATION_PROMPT);
  const trimmed = response.trim();

  // Sanity check: if LLM returned something too short or too long, skip
  if (trimmed.length < 10 || trimmed.length > 2000) {
    return null;
  }

  return trimmed;
}

function findClusters(
  facts: MemoryFact[],
  embeddings: Float32Array[],
  threshold: number,
  minSize: number,
): MemoryFact[][] {
  const assigned = new Set<number>();
  const clusters: MemoryFact[][] = [];

  for (let i = 0; i < facts.length; i++) {
    if (assigned.has(i)) continue;

    const cluster: number[] = [i];
    for (let j = i + 1; j < facts.length; j++) {
      if (assigned.has(j)) continue;
      const sim = cosineSimilarity(embeddings[i], embeddings[j]);
      if (sim >= threshold) {
        cluster.push(j);
      }
    }

    if (cluster.length >= minSize) {
      clusters.push(cluster.map((idx) => facts[idx]));
      for (const idx of cluster) assigned.add(idx);
    }
  }

  return clusters;
}

function inferConsolidatedType(facts: MemoryFact[]): MemoryFact['type'] {
  // Use the most common type in the cluster
  const counts = new Map<string, number>();
  for (const f of facts) {
    counts.set(f.type, (counts.get(f.type) ?? 0) + 1);
  }
  let maxType = facts[0].type;
  let maxCount = 0;
  for (const [type, count] of counts) {
    if (count > maxCount) {
      maxType = type as MemoryFact['type'];
      maxCount = count;
    }
  }
  return maxType;
}

function earliest(dates: string[]): string {
  return dates.reduce((a, b) => (a < b ? a : b));
}

function mergedTags(facts: MemoryFact[]): string[] {
  const tags = new Set<string>();
  for (const f of facts) {
    for (const t of f.tags) tags.add(t);
  }
  return Array.from(tags);
}
