/**
 * @domain subdomain: Memory System (Paisley Park)
 * @domain subdomain-type: core
 * @domain type: app-service
 * @domain layer: application
 *
 * PaisleyPark — standalone project memory system.
 * Uses libSQL for storage (local SQLite or remote sync via embedded replicas).
 * Provides recall, add, invalidate, evolve, search, and timeline operations.
 */

import type { Client } from '@libsql/client';

import {
  checkAdmission,
  runConsolidation,
  shouldConsolidate,
  markConsolidated,
} from './consolidator.js';
import type { ConsolidationResult } from './consolidator.js';
import { createEmbeddingProvider } from './embedding.js';
import { formatRecallContext } from './formatter.js';
import { RelationshipGraph } from './graph.js';
import { log } from './logger.js';
import { RetrievalEngine } from './retrieval.js';
import {
  createDb,
  generateFactId,
  getFact,
  initSchema,
  insertFact,
  listFacts,
  syncDb,
  updateFact,
} from './storage.js';
import { AccessTracker, canEvolve, findPotentialConflicts, inferDecayClass } from './temporal.js';
import type {
  AddOptions,
  EmbeddingProvider,
  LLMConfig,
  MemoryFact,
  MemoryRecallResult,
  OperatorProfile,
  RecallOptions,
  SearchFilters,
  StorageConfig,
  TimelineOptions,
} from './types.js';
import { VectorIndex } from './vector-index.js';

// ─── Re-exports ────────────────────────────────────────

export { setMemoryLogSink } from './logger.js';
export type { MemoryLogger } from './logger.js';
export { runGC, shouldRunGC, trackThreadCompletion, markGCComplete } from './gc.js';
export type { GCResult } from './gc.js';
export {
  runConsolidation,
  checkAdmission,
  shouldConsolidate,
  markConsolidated,
} from './consolidator.js';
export type { ConsolidationResult } from './consolidator.js';
export { llmComplete, llmHealthCheck } from './llm.js';
export type {
  FactType,
  DecayClass,
  MemoryScope,
  MemoryFact,
  MemoryRecallResult,
  RecallOptions,
  AddOptions,
  SearchFilters,
  TimelineOptions,
  StorageConfig,
  LLMConfig,
  EmbeddingProvider,
  OperatorProfile,
} from './types.js';

// ─── PaisleyPark class ─────────────────────────────────

export class PaisleyPark {
  private config: StorageConfig;
  private db!: Client;
  private graph: RelationshipGraph;
  private vectorIndex!: VectorIndex;
  private retrieval!: RetrievalEngine;
  private accessTracker: AccessTracker;
  private embeddingProvider!: EmbeddingProvider;
  private initialized = false;

  constructor(config: StorageConfig) {
    this.config = config;
    this.graph = new RelationshipGraph();

    this.accessTracker = new AccessTracker(async (updates) => {
      await this.flushAccessUpdates(updates);
    });
  }

  // ─── Lazy initialization ───────────────────────────

  async init(): Promise<void> {
    if (this.initialized) return;

    // Create DB connection
    this.db = createDb(this.config);

    // Initialize schema
    const schemaResult = await initSchema(this.db);
    if (schemaResult.isErr()) throw new Error(schemaResult.error);

    // Sync if using embedded replica
    await syncDb(this.db);

    // Initialize embedding provider
    this.embeddingProvider = await createEmbeddingProvider();

    // Initialize vector index (same DB)
    this.vectorIndex = new VectorIndex(this.db, this.embeddingProvider);

    // Build relationship graph from existing facts
    const factsResult = await listFacts(this.db, this.config.projectId);
    if (factsResult.isOk()) {
      this.graph.buildFromFacts(factsResult.value);

      // Rebuild vector index if model changed or index is empty
      if (this.vectorIndex.isAvailable()) {
        const needsRebuild = await this.vectorIndex.needsRebuild();
        const indexCount = await this.vectorIndex.getFactCount();

        if ((needsRebuild || indexCount === 0) && factsResult.value.length > 0) {
          log.info('Rebuilding vector index', { namespace: 'memory' });
          await this.vectorIndex.rebuild(
            factsResult.value.map((f) => ({ id: f.id, content: f.content })),
          );
        }
      }
    }

    // Initialize retrieval engine
    this.retrieval = new RetrievalEngine(
      this.db,
      this.config.projectId,
      this.vectorIndex,
      this.graph,
    );

    this.initialized = true;
    log.info(`Paisley Park initialized for "${this.config.projectName}"`, {
      namespace: 'memory',
      url: this.config.url,
      syncUrl: this.config.syncUrl ?? 'none',
      factCount: factsResult.isOk() ? factsResult.value.length : 0,
      vectorAvailable: this.vectorIndex.isAvailable(),
    });
  }

  // ─── recall() ──────────────────────────────────────

  async recall(query: string, options?: RecallOptions): Promise<MemoryRecallResult> {
    await this.init();

    const facts = await this.retrieval.recall(query, options);

    // Track access for returned facts
    for (const fact of facts) {
      this.accessTracker.track(fact.id);
    }

    // Load operator profile if requested
    let operator: OperatorProfile | null = null;
    if (options?.forOperator) {
      operator = await this.loadOperatorProfile(options.forOperator);
    }

    const formattedContext = formatRecallContext(facts, operator);

    return {
      facts,
      formattedContext,
      totalFound: facts.length,
    };
  }

  // ─── add() ─────────────────────────────────────────

  async add(content: string, options: AddOptions): Promise<MemoryFact> {
    await this.init();

    // Admission filter: reject derivable content
    if (this.config.llm) {
      const admission = await checkAdmission(this.config.llm, content);
      if (!admission.admitted) {
        throw new Error(`Fact rejected: ${admission.reason}`);
      }
    }

    const now = new Date().toISOString();
    const id = generateFactId();
    const decayClass = options.decayClass ?? inferDecayClass(options.type);
    const related = options.relatedTo ?? [];

    // Run conflict detection
    const existingResult = await listFacts(this.db, this.config.projectId);
    if (existingResult.isOk() && existingResult.value.length > 0) {
      const conflicts = await findPotentialConflicts(
        content,
        existingResult.value,
        this.embeddingProvider,
      );

      for (const conflict of conflicts) {
        if (conflict.relation === 'extends' || conflict.relation === 'duplicate') {
          if (!related.includes(conflict.existingFactId)) {
            related.push(conflict.existingFactId);
          }
        }
      }

      if (conflicts.length > 0) {
        log.info(`Conflict detection found ${conflicts.length} related facts`, {
          namespace: 'memory',
          factId: id,
          conflicts: conflicts.map(
            (c) => `${c.existingFactId} (${c.relation}, ${c.confidence.toFixed(2)})`,
          ),
        });
      }
    }

    const fact: MemoryFact = {
      id,
      type: options.type,
      content,
      confidence: options.confidence ?? 0.8,
      sourceAgent: options.sourceAgent ?? null,
      sourceOperator: options.sourceOperator ?? null,
      sourceSession: options.sourceSession ?? null,
      validFrom: options.validFrom ?? now,
      invalidAt: null,
      ingestedAt: now,
      invalidatedBy: null,
      supersededBy: null,
      tags: options.tags ?? [],
      related,
      decayClass,
      accessCount: 0,
      lastAccessed: now,
      projectId: this.config.projectId,
    };

    const insertResult = await insertFact(this.db, fact);
    if (insertResult.isErr()) throw new Error(insertResult.error);

    // Update indexes
    await this.vectorIndex.addVector(id, content);
    for (const relId of related) {
      this.graph.addEdge(id, relId);
    }

    // Sync to remote if using embedded replica
    await syncDb(this.db);

    return fact;
  }

  // ─── invalidate() ──────────────────────────────────

  async invalidate(factId: string, reason?: string): Promise<void> {
    await this.init();

    const factResult = await getFact(this.db, factId);
    if (factResult.isErr()) throw new Error(factResult.error);

    await updateFact(this.db, factId, {
      invalid_at: new Date().toISOString(),
      invalidated_by: reason ?? null,
      content: `${factResult.value.content}\n\n---\n_Invalidated: ${reason ?? 'no reason given'}_`,
    });

    // Update indexes
    await this.vectorIndex.removeVector(factId);
    this.graph.removeNode(factId);

    await syncDb(this.db);
  }

  // ─── evolve() ──────────────────────────────────────

  async evolve(factId: string, update: string): Promise<MemoryFact> {
    await this.init();

    const factResult = await getFact(this.db, factId);
    if (factResult.isErr()) throw new Error(factResult.error);

    const fact = factResult.value;
    if (!canEvolve(fact)) {
      throw new Error(`Cannot evolve invalidated fact ${factId}`);
    }

    const newContent = `${fact.content}\n\n---\n_Updated: ${update}_`;
    const now = new Date().toISOString();

    await updateFact(this.db, factId, {
      content: newContent,
      ingested_at: now,
    });

    // Re-embed
    await this.vectorIndex.addVector(factId, newContent);

    await syncDb(this.db);

    // Return updated fact
    const updatedResult = await getFact(this.db, factId);
    if (updatedResult.isErr()) throw new Error(updatedResult.error);
    return updatedResult.value;
  }

  // ─── search() ──────────────────────────────────────

  async search(query: string, filters?: SearchFilters): Promise<MemoryFact[]> {
    await this.init();
    return this.retrieval.search(query, filters);
  }

  // ─── timeline() ────────────────────────────────────

  async timeline(options?: TimelineOptions): Promise<MemoryFact[]> {
    await this.init();
    return this.retrieval.timeline(options);
  }

  // ─── consolidate() ─────────────────────────────────

  async consolidate(): Promise<ConsolidationResult> {
    await this.init();

    if (!this.config.llm) {
      throw new Error(
        'LLM not configured — pass llm option in StorageConfig to enable consolidation',
      );
    }

    return runConsolidation(
      this.db,
      this.config.projectId,
      this.config.llm,
      this.embeddingProvider,
    );
  }

  // ─── Access tracking flush ─────────────────────────

  private async flushAccessUpdates(updates: Map<string, { count: number; lastAccessed: string }>) {
    for (const [factId, update] of updates) {
      const factResult = await getFact(this.db, factId);
      if (factResult.isErr()) continue;

      await updateFact(this.db, factId, {
        access_count: factResult.value.accessCount + update.count,
        last_accessed: update.lastAccessed,
      });
    }
    await syncDb(this.db);
  }

  // ─── Operator profile loading ──────────────────────

  private async loadOperatorProfile(operatorId: string): Promise<OperatorProfile | null> {
    // Operator profiles are stored as facts with type 'convention'
    // and tagged with 'operator-profile' + operator ID
    const result = await this.retrieval.search(`operator profile ${operatorId}`, {
      tags: ['operator-profile'],
    });

    if (result.length === 0) return null;

    // Parse structured operator data from the fact content
    const content = result[0].content;
    return {
      operator: operatorId,
      role: extractField(content, 'Role'),
      expertise: extractList(content, 'Expertise'),
      languages: extractList(content, 'Languages'),
      preferences: extractList(content, 'Preferences'),
      notes: extractList(content, 'Notes'),
    };
  }

  // ─── Cleanup ───────────────────────────────────────

  async destroy() {
    await this.accessTracker.flush();
    this.accessTracker.destroy();
    this.db?.close();
  }

  // ─── Getters ───────────────────────────────────────

  get projectId(): string {
    return this.config.projectId;
  }

  get isInitialized(): boolean {
    return this.initialized;
  }

  /** @internal — exposed for GC and tests */
  getDb(): Client {
    return this.db;
  }

  /** @internal */
  getGraph(): RelationshipGraph {
    return this.graph;
  }

  /** @internal */
  getVectorIndex(): VectorIndex {
    return this.vectorIndex;
  }

  /** @internal */
  getEmbeddingProvider(): EmbeddingProvider {
    return this.embeddingProvider;
  }
}

// ─── PaisleyPark instance factory (per project) ────────

const instances = new Map<string, PaisleyPark>();

export function getPaisleyPark(config: StorageConfig): PaisleyPark {
  let instance = instances.get(config.projectId);
  if (!instance) {
    instance = new PaisleyPark(config);
    instances.set(config.projectId, instance);
  }
  return instance;
}

export async function destroyAllInstances() {
  for (const [, instance] of instances) {
    await instance.destroy();
  }
  instances.clear();
}

// ─── Helpers ───────────────────────────────────────────

function extractField(content: string, field: string): string | undefined {
  const regex = new RegExp(`\\*\\*${field}:\\*\\*\\s*(.+)`, 'i');
  const match = content.match(regex);
  return match?.[1]?.trim();
}

function extractList(content: string, section: string): string[] | undefined {
  const regex = new RegExp(`\\*\\*${section}:\\*\\*`, 'i');
  const match = content.match(regex);
  if (!match?.index) return undefined;

  const startIdx = match.index + match[0].length;
  const nextField = content.indexOf('**', startIdx + 1);
  const block = nextField > -1 ? content.slice(startIdx, nextField) : content.slice(startIdx);

  const items = block
    .split('\n')
    .filter((l) => l.trim().startsWith('-'))
    .map((l) => l.replace(/^-\s*/, '').trim())
    .filter(Boolean);

  return items.length > 0 ? items : undefined;
}
