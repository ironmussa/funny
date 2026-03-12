/**
 * @domain subdomain: Memory System (Paisley Park)
 * @domain subdomain-type: core
 * @domain type: app-service
 * @domain layer: application
 *
 * PaisleyPark — the main entry point for Funny's project memory system.
 * Provides recall, add, invalidate, evolve, search, and timeline operations.
 * Initializes lazily per project.
 */

import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';

import type {
  AddOptions,
  MemoryFact,
  MemoryRecallResult,
  RecallOptions,
  SearchFilters,
  TimelineOptions,
} from '@funny/shared';
import { Result, err, ok } from 'neverthrow';

import { createEmbeddingProvider } from './embedding.js';
import { formatRecallContext } from './formatter.js';
import { RelationshipGraph } from './graph.js';
import { log } from './logger.js';
import { RetrievalEngine } from './retrieval.js';
import {
  createWriteLock,
  factIdToPath,
  generateFactId,
  gitCommit,
  initMemoryDir,
  listFacts,
  moveFact,
  readFact,
  regenerateIndex,
  slugify,
  writeFact,
} from './storage.js';
import {
  AccessTracker,
  canEvolve,
  evolveFact,
  findPotentialConflicts,
  inferDecayClass,
  invalidateFact,
} from './temporal.js';
import type {
  EmbeddingProvider,
  MemoryFactFrontmatter,
  OperatorProfile,
  StorageConfig,
  WriteLock,
} from './types.js';
import { frontmatterToApi } from './types.js';
import { VectorIndex } from './vector-index.js';

// ─── Re-exports ──────────────────────────────────────────
export { setMemoryLogSink } from './logger.js';
export type { MemoryLogger } from './logger.js';
export { runGC, shouldRunGC, trackThreadCompletion, markGCComplete } from './gc.js';
export type { GCResult } from './gc.js';

// ─── PaisleyPark class ──────────────────────────────────

export class PaisleyPark {
  private storageConfig: StorageConfig;
  private lock: WriteLock;
  private graph: RelationshipGraph;
  private vectorIndex!: VectorIndex;
  private retrieval!: RetrievalEngine;
  private accessTracker: AccessTracker;
  private embeddingProvider!: EmbeddingProvider;
  private initialized = false;

  constructor(config: StorageConfig) {
    this.storageConfig = config;
    this.lock = createWriteLock(config.memoryDir);
    this.graph = new RelationshipGraph();

    this.accessTracker = new AccessTracker(async (updates) => {
      await this.flushAccessUpdates(updates);
    });
  }

  // ─── Lazy initialization ────────────────────────────

  async init(): Promise<Result<void, string>> {
    if (this.initialized) return ok(undefined);

    const dirResult = await initMemoryDir(this.storageConfig);
    if (dirResult.isErr()) return err(dirResult.error);

    // Initialize embedding provider
    this.embeddingProvider = await createEmbeddingProvider();

    // Initialize vector index
    this.vectorIndex = new VectorIndex(this.storageConfig.memoryDir, this.embeddingProvider);
    const vecResult = await this.vectorIndex.init();
    if (vecResult.isErr()) {
      log.warn('Vector index init failed, continuing without', {
        namespace: 'memory',
        error: vecResult.error,
      });
    }

    // Build relationship graph from existing facts
    const factsResult = await listFacts(this.storageConfig.memoryDir);
    if (factsResult.isOk()) {
      this.graph.buildFromFacts(factsResult.value);

      // If vector index is empty but facts exist, trigger rebuild
      if (
        this.vectorIndex.isAvailable() &&
        this.vectorIndex.getFactCount() === 0 &&
        factsResult.value.length > 0
      ) {
        log.info('Rebuilding vector index from existing facts', { namespace: 'memory' });
        await this.vectorIndex.rebuild(
          factsResult.value.map((f) => ({ id: f.frontmatter.id, content: f.content })),
        );
      }
    }

    // Initialize retrieval engine
    this.retrieval = new RetrievalEngine(
      this.storageConfig.memoryDir,
      this.vectorIndex,
      this.graph,
    );

    this.initialized = true;
    log.info(`Paisley Park initialized for project "${this.storageConfig.projectName}"`, {
      namespace: 'memory',
      memoryDir: this.storageConfig.memoryDir,
      factCount: factsResult.isOk() ? factsResult.value.length : 0,
      vectorAvailable: this.vectorIndex.isAvailable(),
    });

    return ok(undefined);
  }

  // ─── recall() ───────────────────────────────────────

  async recall(
    query: string,
    options?: RecallOptions,
  ): Promise<Result<MemoryRecallResult, string>> {
    const initResult = await this.init();
    if (initResult.isErr()) return err(initResult.error);

    try {
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

      return ok({
        facts,
        formattedContext,
        totalFound: facts.length,
      });
    } catch (e) {
      return err(`Recall failed: ${e}`);
    }
  }

  // ─── add() ──────────────────────────────────────────

  async add(content: string, options: AddOptions): Promise<Result<MemoryFact, string>> {
    const initResult = await this.init();
    if (initResult.isErr()) return err(initResult.error);

    const now = new Date().toISOString();
    const id = generateFactId();
    const decayClass = options.decayClass ?? inferDecayClass(options.type);

    const frontmatter: MemoryFactFrontmatter = {
      id,
      type: options.type,
      confidence: options.confidence ?? 0.8,
      source_agent: options.sourceAgent ?? null,
      source_operator: options.sourceOperator ?? null,
      source_session: options.sourceSession ?? null,
      valid_from: options.validFrom ?? now,
      invalid_at: null,
      ingested_at: now,
      invalidated_by: null,
      superseded_by: null,
      tags: options.tags ?? [],
      related: options.relatedTo ?? [],
      decay_class: decayClass,
      access_count: 0,
      last_accessed: now,
    };

    try {
      await this.lock.acquire();

      // Run conflict detection (non-blocking — doesn't prevent write)
      const existingFacts = await listFacts(this.storageConfig.memoryDir);
      if (existingFacts.isOk() && existingFacts.value.length > 0) {
        const validFacts = existingFacts.value.filter((f) => f.frontmatter.invalid_at === null);
        const conflicts = await findPotentialConflicts(content, validFacts, this.embeddingProvider);

        // Auto-link related facts
        for (const conflict of conflicts) {
          if (conflict.relation === 'extends' || conflict.relation === 'duplicate') {
            if (!frontmatter.related.includes(conflict.existingFactId)) {
              frontmatter.related.push(conflict.existingFactId);
            }
          }
        }

        // Log conflicts for awareness
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

      // Write fact file
      const relativePath = factIdToPath(id);
      const writeResult = await writeFact(
        this.storageConfig.memoryDir,
        relativePath,
        frontmatter,
        content,
      );
      if (writeResult.isErr()) return err(writeResult.error);

      // Update indexes
      await this.vectorIndex.addVector(id, content);
      for (const relId of frontmatter.related) {
        this.graph.addEdge(id, relId);
      }

      // Regenerate INDEX.md
      await regenerateIndex(this.storageConfig.memoryDir);

      // Git commit
      const slug = slugify(content.split('\n')[0]);
      gitCommit(this.storageConfig.memoryDir, `memory: add ${options.type} — ${slug}`);

      return ok(frontmatterToApi(frontmatter, content));
    } catch (e) {
      return err(`Failed to add fact: ${e}`);
    } finally {
      this.lock.release();
    }
  }

  // ─── invalidate() ───────────────────────────────────

  async invalidate(factId: string, reason?: string): Promise<Result<void, string>> {
    const initResult = await this.init();
    if (initResult.isErr()) return err(initResult.error);

    const relativePath = factIdToPath(factId);

    try {
      await this.lock.acquire();

      const factResult = await readFact(this.storageConfig.memoryDir, relativePath);
      if (factResult.isErr()) return err(factResult.error);

      const { frontmatter, content } = factResult.value;
      const updated = invalidateFact(frontmatter, reason);

      // Append invalidation note to content
      const updatedContent = `${content}\n\n---\n_Invalidated: ${reason ?? 'no reason given'}_`;

      const writeResult = await writeFact(
        this.storageConfig.memoryDir,
        relativePath,
        updated,
        updatedContent,
      );
      if (writeResult.isErr()) return err(writeResult.error);

      // Update indexes
      this.vectorIndex.removeVector(factId);
      this.graph.removeNode(factId);

      // Regenerate INDEX.md
      await regenerateIndex(this.storageConfig.memoryDir);

      gitCommit(
        this.storageConfig.memoryDir,
        `memory: invalidate ${factId}${reason ? ` — ${reason}` : ''}`,
      );

      return ok(undefined);
    } catch (e) {
      return err(`Failed to invalidate fact: ${e}`);
    } finally {
      this.lock.release();
    }
  }

  // ─── evolve() ───────────────────────────────────────

  async evolve(factId: string, update: string): Promise<Result<MemoryFact, string>> {
    const initResult = await this.init();
    if (initResult.isErr()) return err(initResult.error);

    const relativePath = factIdToPath(factId);

    try {
      await this.lock.acquire();

      const factResult = await readFact(this.storageConfig.memoryDir, relativePath);
      if (factResult.isErr()) return err(factResult.error);

      const { frontmatter, content } = factResult.value;

      if (!canEvolve(frontmatter)) {
        return err(`Cannot evolve invalidated fact ${factId}`);
      }

      const updated = evolveFact(frontmatter);
      const newContent = `${content}\n\n---\n_Updated: ${update}_`;

      const writeResult = await writeFact(
        this.storageConfig.memoryDir,
        relativePath,
        updated,
        newContent,
      );
      if (writeResult.isErr()) return err(writeResult.error);

      // Re-embed
      await this.vectorIndex.addVector(factId, newContent);

      // Regenerate INDEX.md
      await regenerateIndex(this.storageConfig.memoryDir);

      gitCommit(this.storageConfig.memoryDir, `memory: evolve ${factId}`);

      return ok(frontmatterToApi(updated, newContent));
    } catch (e) {
      return err(`Failed to evolve fact: ${e}`);
    } finally {
      this.lock.release();
    }
  }

  // ─── search() ───────────────────────────────────────

  async search(query: string, filters?: SearchFilters): Promise<Result<MemoryFact[], string>> {
    const initResult = await this.init();
    if (initResult.isErr()) return err(initResult.error);

    try {
      const results = await this.retrieval.search(query, filters);
      return ok(results);
    } catch (e) {
      return err(`Search failed: ${e}`);
    }
  }

  // ─── timeline() ─────────────────────────────────────

  async timeline(options?: TimelineOptions): Promise<Result<MemoryFact[], string>> {
    const initResult = await this.init();
    if (initResult.isErr()) return err(initResult.error);

    try {
      const results = await this.retrieval.timeline(options);
      return ok(results);
    } catch (e) {
      return err(`Timeline failed: ${e}`);
    }
  }

  // ─── Access tracking flush ──────────────────────────

  private async flushAccessUpdates(updates: Map<string, { count: number; lastAccessed: string }>) {
    for (const [factId, update] of updates) {
      const relativePath = factIdToPath(factId);
      const factResult = await readFact(this.storageConfig.memoryDir, relativePath);
      if (factResult.isErr()) continue;

      const { frontmatter, content } = factResult.value;
      frontmatter.access_count += update.count;
      frontmatter.last_accessed = update.lastAccessed;

      await writeFact(this.storageConfig.memoryDir, relativePath, frontmatter, content);
    }
    // Batch commit for access tracking
    gitCommit(this.storageConfig.memoryDir, 'memory: update access tracking');
  }

  // ─── Operator profile loading ───────────────────────

  private async loadOperatorProfile(operatorId: string): Promise<OperatorProfile | null> {
    const profilePath = join(this.storageConfig.memoryDir, 'operators', operatorId, 'PROFILE.md');
    if (!existsSync(profilePath)) return null;

    try {
      const matter = (await import('gray-matter')).default as any;
      const raw = await readFile(profilePath, 'utf-8');
      const parsed = matter(raw);

      return {
        operator: operatorId,
        role: parsed.data.role,
        expertise: parsed.data.expertise,
        languages: parsed.data.languages,
        preferences:
          extractListSection(parsed.content, 'Preferencias de trabajo') ||
          extractListSection(parsed.content, 'Work preferences'),
        notes:
          extractListSection(parsed.content, 'Notas para los agentes') ||
          extractListSection(parsed.content, 'Notes for agents'),
      };
    } catch {
      return null;
    }
  }

  // ─── Session metadata tracking ─────────────────────

  async trackSession(
    threadId: string,
    data: { operator?: string; model?: string; status?: string },
  ): Promise<void> {
    const initResult = await this.init();
    if (initResult.isErr()) return;

    const now = new Date().toISOString();
    const sessionDir = join(this.storageConfig.memoryDir, 'sessions', threadId);
    const metaPath = join(sessionDir, 'meta.md');

    try {
      const { mkdir: mkdirFs, writeFile: writeFs } = await import('fs/promises');
      await mkdirFs(sessionDir, { recursive: true });

      const content = [
        '---',
        `thread_id: ${threadId}`,
        `operator: ${data.operator ?? 'unknown'}`,
        `model: ${data.model ?? 'unknown'}`,
        `status: ${data.status ?? 'started'}`,
        `timestamp: ${now}`,
        '---',
        '',
        `Session ${threadId} — ${data.status ?? 'started'} at ${now}`,
      ].join('\n');

      await writeFs(metaPath, content);
    } catch {
      // Non-critical — don't block on session tracking failures
    }
  }

  // ─── Cleanup ────────────────────────────────────────

  async destroy() {
    await this.accessTracker.flush();
    this.accessTracker.destroy();
    this.vectorIndex?.close();
  }

  // ─── Getters ────────────────────────────────────────

  get memoryDir(): string {
    return this.storageConfig.memoryDir;
  }

  get projectId(): string {
    return this.storageConfig.projectId;
  }

  get isInitialized(): boolean {
    return this.initialized;
  }

  getGraph(): RelationshipGraph {
    return this.graph;
  }

  getVectorIndex(): VectorIndex {
    return this.vectorIndex;
  }

  getEmbeddingProvider(): EmbeddingProvider {
    return this.embeddingProvider;
  }
}

// ─── PaisleyPark instance factory (per project) ─────────

const instances = new Map<string, PaisleyPark>();

export function getMemoryDir(projectId: string): string {
  const dataDir = process.env.FUNNY_DATA_DIR
    ? join(process.cwd(), process.env.FUNNY_DATA_DIR)
    : join(homedir(), '.funny');
  return join(dataDir, 'memory', projectId);
}

export function getPaisleyPark(projectId: string, projectName: string): PaisleyPark {
  let instance = instances.get(projectId);
  if (!instance) {
    instance = new PaisleyPark({
      memoryDir: getMemoryDir(projectId),
      projectId,
      projectName,
    });
    instances.set(projectId, instance);
  }
  return instance;
}

export async function destroyAllInstances() {
  for (const [, instance] of instances) {
    await instance.destroy();
  }
  instances.clear();
}

// ─── Helpers ────────────────────────────────────────────

function extractListSection(content: string, sectionTitle: string): string[] | undefined {
  const regex = new RegExp(`##\\s*${sectionTitle}`, 'i');
  const match = content.match(regex);
  if (!match) return undefined;

  const startIdx = match.index! + match[0].length;
  const nextSection = content.indexOf('\n## ', startIdx);
  const section = nextSection > -1 ? content.slice(startIdx, nextSection) : content.slice(startIdx);

  const items = section
    .split('\n')
    .filter((l) => l.trim().startsWith('-'))
    .map((l) => l.replace(/^-\s*/, '').trim())
    .filter(Boolean);

  return items.length > 0 ? items : undefined;
}
