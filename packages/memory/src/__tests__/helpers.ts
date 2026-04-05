/**
 * Shared test helpers for @funny/memory tests.
 */

import { createClient, type Client } from '@libsql/client';

import { initSchema } from '../storage.js';
import type { EmbeddingProvider, MemoryFact, StorageConfig } from '../types.js';

// ─── In-memory DB ─────────────────────────────────────

let dbCounter = 0;

export async function createTestDb(): Promise<Client> {
  const db = createClient({ url: ':memory:' });
  await initSchema(db);
  return db;
}

export function testConfig(overrides: Partial<StorageConfig> = {}): StorageConfig {
  dbCounter++;
  return {
    url: ':memory:',
    projectId: `test-project-${dbCounter}`,
    projectName: `Test Project ${dbCounter}`,
    ...overrides,
  };
}

// ─── Fake fact factory ────────────────────────────────

let factCounter = 0;

export function makeFact(overrides: Partial<MemoryFact> = {}): MemoryFact {
  factCounter++;
  const now = new Date().toISOString();
  return {
    id: `fact-test-${factCounter}`,
    type: 'insight',
    content: `Test fact content ${factCounter}`,
    confidence: 0.8,
    sourceAgent: null,
    sourceOperator: null,
    sourceSession: null,
    validFrom: now,
    invalidAt: null,
    ingestedAt: now,
    invalidatedBy: null,
    supersededBy: null,
    tags: [],
    related: [],
    decayClass: 'normal',
    accessCount: 0,
    lastAccessed: now,
    projectId: 'test-project',
    ...overrides,
  };
}

// ─── Mock embedding provider ──────────────────────────

/**
 * A deterministic mock embedding provider that produces
 * consistent vectors from text content (simple hash-based).
 */
export class MockEmbeddingProvider implements EmbeddingProvider {
  private dim: number;

  constructor(dimensions: number = 8) {
    this.dim = dimensions;
  }

  async embed(text: string): Promise<Float32Array> {
    return this.hashToVector(text);
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => this.hashToVector(t));
  }

  dimensions(): number {
    return this.dim;
  }

  modelId(): string {
    return 'mock:test';
  }

  private hashToVector(text: string): Float32Array {
    const vec = new Float32Array(this.dim);
    for (let i = 0; i < text.length; i++) {
      vec[i % this.dim] += text.charCodeAt(i);
    }
    // Normalize
    let norm = 0;
    for (let i = 0; i < this.dim; i++) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let i = 0; i < this.dim; i++) vec[i] /= norm;
    }
    return vec;
  }
}

export class NullMockEmbeddingProvider implements EmbeddingProvider {
  async embed(_text: string): Promise<Float32Array> {
    return new Float32Array(0);
  }
  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return texts.map(() => new Float32Array(0));
  }
  dimensions(): number {
    return 0;
  }
  modelId(): string {
    return 'null';
  }
}
