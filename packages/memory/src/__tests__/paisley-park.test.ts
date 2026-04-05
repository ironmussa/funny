import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { PaisleyPark, destroyAllInstances, getPaisleyPark } from '../index.js';
import type { StorageConfig } from '../types.js';

// Mock createEmbeddingProvider to always return NullEmbeddingProvider
// (avoids hitting real Ollama/OpenAI in tests)
vi.mock('../embedding.js', () => ({
  createEmbeddingProvider: vi.fn().mockResolvedValue({
    embed: vi.fn().mockResolvedValue(new Float32Array(0)),
    embedBatch: vi
      .fn()
      .mockImplementation((texts: string[]) =>
        Promise.resolve(texts.map(() => new Float32Array(0))),
      ),
    dimensions: vi.fn().mockReturnValue(0),
    modelId: vi.fn().mockReturnValue('null'),
  }),
}));

describe('PaisleyPark (integration)', () => {
  let config: StorageConfig;
  let configCounter = 0;

  beforeEach(async () => {
    await destroyAllInstances();
    configCounter++;
    config = {
      url: ':memory:',
      projectId: `integration-test-${configCounter}`,
      projectName: `Integration Test ${configCounter}`,
    };
  });

  afterEach(async () => {
    await destroyAllInstances();
  });

  // ─── Initialization ─────────────────────────────────

  describe('initialization', () => {
    it('initializes lazily on first operation', async () => {
      const pp = new PaisleyPark(config);
      expect(pp.isInitialized).toBe(false);

      await pp.init();
      expect(pp.isInitialized).toBe(true);
    });

    it('init is idempotent', async () => {
      const pp = new PaisleyPark(config);
      await pp.init();
      await pp.init(); // should not throw
      expect(pp.isInitialized).toBe(true);
    });

    it('exposes projectId', () => {
      const pp = new PaisleyPark(config);
      expect(pp.projectId).toBe(config.projectId);
    });
  });

  // ─── add + recall ───────────────────────────────────

  describe('add and recall', () => {
    it('adds a fact and recalls it', async () => {
      const pp = new PaisleyPark(config);

      const fact = await pp.add('Use libSQL for database storage in the memory system', {
        type: 'decision',
        tags: ['architecture', 'storage'],
        confidence: 0.9,
      });

      expect(fact.id).toBeDefined();
      expect(fact.type).toBe('decision');
      expect(fact.content).toBe('Use libSQL for database storage in the memory system');
      expect(fact.tags).toEqual(['architecture', 'storage']);
      expect(fact.confidence).toBe(0.9);
      expect(fact.projectId).toBe(config.projectId);

      const result = await pp.recall('libSQL database');
      expect(result.facts.length).toBeGreaterThan(0);
      expect(result.facts.some((f) => f.id === fact.id)).toBe(true);
      expect(result.totalFound).toBeGreaterThan(0);
    });

    it('returns formatted context in recall', async () => {
      const pp = new PaisleyPark(config);
      await pp.add('React components should use functional style', {
        type: 'convention',
      });

      const result = await pp.recall('React');
      expect(result.formattedContext).toContain('[PROJECT MEMORY]');
      expect(result.formattedContext).toContain('React');
    });

    it('returns empty recall for no matches', async () => {
      const pp = new PaisleyPark(config);
      const result = await pp.recall('nonexistent topic xyz123');
      expect(result.facts).toEqual([]);
      expect(result.formattedContext).toBe('');
      expect(result.totalFound).toBe(0);
    });

    it('uses default confidence of 0.8', async () => {
      const pp = new PaisleyPark(config);
      const fact = await pp.add('A fact with default confidence', { type: 'insight' });
      expect(fact.confidence).toBe(0.8);
    });

    it('infers decay class from fact type', async () => {
      const pp = new PaisleyPark(config);

      const decision = await pp.add('A decision', { type: 'decision' });
      expect(decision.decayClass).toBe('slow');

      const context = await pp.add('Some context', { type: 'context' });
      expect(context.decayClass).toBe('fast');
    });

    it('allows overriding decay class', async () => {
      const pp = new PaisleyPark(config);
      const fact = await pp.add('Override test', { type: 'context', decayClass: 'slow' });
      expect(fact.decayClass).toBe('slow');
    });
  });

  // ─── invalidate ─────────────────────────────────────

  describe('invalidate', () => {
    it('invalidates a fact', async () => {
      const pp = new PaisleyPark(config);
      const fact = await pp.add('This fact will be invalidated shortly', { type: 'insight' });

      await pp.invalidate(fact.id, 'no longer relevant');

      // Should not appear in recall
      const result = await pp.recall('invalidated');
      expect(result.facts.every((f) => f.id !== fact.id)).toBe(true);
    });

    it('throws for non-existing fact', async () => {
      const pp = new PaisleyPark(config);
      await pp.init();
      await expect(pp.invalidate('nonexistent-id')).rejects.toThrow();
    });
  });

  // ─── evolve ─────────────────────────────────────────

  describe('evolve', () => {
    it('evolves a fact with new content', async () => {
      const pp = new PaisleyPark(config);
      const original = await pp.add('Initial understanding of the auth system', {
        type: 'insight',
      });

      const evolved = await pp.evolve(original.id, 'Actually uses OAuth2 with PKCE');
      expect(evolved.content).toContain('Initial understanding');
      expect(evolved.content).toContain('OAuth2 with PKCE');
      expect(evolved.id).toBe(original.id);
    });

    it('throws for invalidated fact', async () => {
      const pp = new PaisleyPark(config);
      const fact = await pp.add('Will be invalidated', { type: 'insight' });
      await pp.invalidate(fact.id);

      await expect(pp.evolve(fact.id, 'update')).rejects.toThrow('Cannot evolve invalidated');
    });

    it('throws for non-existing fact', async () => {
      const pp = new PaisleyPark(config);
      await pp.init();
      await expect(pp.evolve('nonexistent', 'update')).rejects.toThrow();
    });
  });

  // ─── search ─────────────────────────────────────────

  describe('search', () => {
    it('searches with type filter', async () => {
      const pp = new PaisleyPark(config);
      await pp.add('Decision about using TypeScript', { type: 'decision' });
      await pp.add('Bug with TypeScript strict mode', { type: 'bug' });

      const results = await pp.search('TypeScript', { type: 'bug' });
      expect(results.length).toBe(1);
      expect(results[0].type).toBe('bug');
    });

    it('returns all facts with empty query', async () => {
      const pp = new PaisleyPark(config);
      await pp.add('First fact', { type: 'decision' });
      await pp.add('Second fact', { type: 'bug' });
      await pp.add('Third fact', { type: 'insight' });

      const results = await pp.search('');
      expect(results.length).toBe(3);
    });

    it('applies type filter with empty query', async () => {
      const pp = new PaisleyPark(config);
      await pp.add('A decision fact', { type: 'decision' });
      await pp.add('A bug fact', { type: 'bug' });
      await pp.add('Another decision', { type: 'decision' });

      const results = await pp.search('', { type: 'decision' });
      expect(results.length).toBe(2);
      expect(results.every((f) => f.type === 'decision')).toBe(true);
    });

    it('applies tag filter with empty query', async () => {
      const pp = new PaisleyPark(config);
      await pp.add('Tagged fact', { type: 'insight', tags: ['auth'] });
      await pp.add('Untagged fact', { type: 'insight' });

      const results = await pp.search('', { tags: ['auth'] });
      expect(results.length).toBe(1);
      expect(results[0].tags).toContain('auth');
    });

    it('returns empty for empty database with empty query', async () => {
      const pp = new PaisleyPark(config);
      const results = await pp.search('');
      expect(results).toEqual([]);
    });
  });

  // ─── timeline ───────────────────────────────────────

  describe('timeline', () => {
    it('returns facts in chronological order', async () => {
      const pp = new PaisleyPark(config);
      await pp.add('First fact', { type: 'insight', validFrom: '2025-01-01T00:00:00Z' });
      await pp.add('Second fact', { type: 'insight', validFrom: '2025-03-01T00:00:00Z' });
      await pp.add('Third fact', { type: 'insight', validFrom: '2025-02-01T00:00:00Z' });

      const results = await pp.timeline();
      expect(results[0].content).toBe('First fact');
      expect(results[1].content).toBe('Third fact');
      expect(results[2].content).toBe('Second fact');
    });
  });

  // ─── consolidate ────────────────────────────────────

  describe('consolidate', () => {
    it('throws when LLM is not configured', async () => {
      const pp = new PaisleyPark(config);
      await pp.init();
      await expect(pp.consolidate()).rejects.toThrow('LLM not configured');
    });
  });

  // ─── Factory ────────────────────────────────────────

  describe('getPaisleyPark', () => {
    it('returns same instance for same projectId', () => {
      const pp1 = getPaisleyPark(config);
      const pp2 = getPaisleyPark(config);
      expect(pp1).toBe(pp2);
    });

    it('returns different instances for different projectIds', () => {
      const pp1 = getPaisleyPark(config);
      const pp2 = getPaisleyPark({
        ...config,
        projectId: 'different-project',
      });
      expect(pp1).not.toBe(pp2);
    });
  });

  // ─── destroy ────────────────────────────────────────

  describe('destroy', () => {
    it('cleans up without error', async () => {
      const pp = new PaisleyPark(config);
      await pp.init();
      await expect(pp.destroy()).resolves.not.toThrow();
    });
  });
});
