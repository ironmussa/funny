import { describe, it, expect } from 'vitest';

import {
  rowToFact,
  factToParams,
  DECAY_LAMBDAS,
  DEFAULT_DECAY_CLASS,
  DEFAULT_GC_CONFIG,
  type FactRow,
  type MemoryFact,
} from '../types.js';

describe('types', () => {
  // ─── Constants ──────────────────────────────────────

  describe('DECAY_LAMBDAS', () => {
    it('should have three decay classes', () => {
      expect(Object.keys(DECAY_LAMBDAS)).toEqual(['slow', 'normal', 'fast']);
    });

    it('slow < normal < fast', () => {
      expect(DECAY_LAMBDAS.slow).toBeLessThan(DECAY_LAMBDAS.normal);
      expect(DECAY_LAMBDAS.normal).toBeLessThan(DECAY_LAMBDAS.fast);
    });

    it('all lambdas are positive', () => {
      for (const v of Object.values(DECAY_LAMBDAS)) {
        expect(v).toBeGreaterThan(0);
      }
    });
  });

  describe('DEFAULT_DECAY_CLASS', () => {
    it('maps all fact types', () => {
      const factTypes = ['decision', 'bug', 'pattern', 'convention', 'insight', 'context'];
      for (const t of factTypes) {
        expect(DEFAULT_DECAY_CLASS[t as keyof typeof DEFAULT_DECAY_CLASS]).toBeDefined();
      }
    });

    it('decisions decay slowly', () => {
      expect(DEFAULT_DECAY_CLASS.decision).toBe('slow');
    });

    it('context decays fast', () => {
      expect(DEFAULT_DECAY_CLASS.context).toBe('fast');
    });
  });

  describe('DEFAULT_GC_CONFIG', () => {
    it('has all required fields', () => {
      expect(DEFAULT_GC_CONFIG.decayThreshold).toBeGreaterThan(0);
      expect(DEFAULT_GC_CONFIG.dedupThreshold).toBeGreaterThan(0);
      expect(DEFAULT_GC_CONFIG.consolidationThreshold).toBeGreaterThan(0);
      expect(DEFAULT_GC_CONFIG.consolidationMinCluster).toBeGreaterThanOrEqual(2);
      expect(DEFAULT_GC_CONFIG.orphanDays).toBeGreaterThan(0);
      expect(DEFAULT_GC_CONFIG.indexRebuildThreshold).toBeGreaterThan(0);
    });
  });

  // ─── rowToFact ──────────────────────────────────────

  describe('rowToFact', () => {
    const sampleRow: FactRow = {
      id: 'fact-2025-01-01-abc1',
      type: 'decision',
      content: 'Use libSQL for storage',
      confidence: 0.9,
      source_agent: 'claude',
      source_operator: 'alice',
      source_session: 'session-1',
      valid_from: '2025-01-01T00:00:00.000Z',
      invalid_at: null,
      ingested_at: '2025-01-01T12:00:00.000Z',
      invalidated_by: null,
      superseded_by: null,
      tags: '["architecture","storage"]',
      related: '["fact-2024-12-01-xyz"]',
      decay_class: 'slow',
      access_count: 5,
      last_accessed: '2025-01-15T00:00:00.000Z',
      project_id: 'proj-1',
    };

    it('converts snake_case DB row to camelCase MemoryFact', () => {
      const fact = rowToFact(sampleRow);
      expect(fact.id).toBe('fact-2025-01-01-abc1');
      expect(fact.type).toBe('decision');
      expect(fact.content).toBe('Use libSQL for storage');
      expect(fact.confidence).toBe(0.9);
      expect(fact.sourceAgent).toBe('claude');
      expect(fact.sourceOperator).toBe('alice');
      expect(fact.sourceSession).toBe('session-1');
      expect(fact.validFrom).toBe('2025-01-01T00:00:00.000Z');
      expect(fact.invalidAt).toBeNull();
      expect(fact.ingestedAt).toBe('2025-01-01T12:00:00.000Z');
      expect(fact.invalidatedBy).toBeNull();
      expect(fact.supersededBy).toBeNull();
      expect(fact.decayClass).toBe('slow');
      expect(fact.accessCount).toBe(5);
      expect(fact.lastAccessed).toBe('2025-01-15T00:00:00.000Z');
      expect(fact.projectId).toBe('proj-1');
    });

    it('parses JSON tags array', () => {
      const fact = rowToFact(sampleRow);
      expect(fact.tags).toEqual(['architecture', 'storage']);
    });

    it('parses JSON related array', () => {
      const fact = rowToFact(sampleRow);
      expect(fact.related).toEqual(['fact-2024-12-01-xyz']);
    });

    it('handles empty/null JSON fields', () => {
      const fact = rowToFact({ ...sampleRow, tags: '', related: '' });
      expect(fact.tags).toEqual([]);
      expect(fact.related).toEqual([]);
    });

    it('handles null tags/related gracefully', () => {
      const fact = rowToFact({ ...sampleRow, tags: '[]', related: '[]' });
      expect(fact.tags).toEqual([]);
      expect(fact.related).toEqual([]);
    });
  });

  // ─── factToParams ───────────────────────────────────

  describe('factToParams', () => {
    const sampleFact: MemoryFact = {
      id: 'fact-2025-01-01-abc1',
      type: 'decision',
      content: 'Use libSQL for storage',
      confidence: 0.9,
      sourceAgent: 'claude',
      sourceOperator: 'alice',
      sourceSession: 'session-1',
      validFrom: '2025-01-01T00:00:00.000Z',
      invalidAt: null,
      ingestedAt: '2025-01-01T12:00:00.000Z',
      invalidatedBy: null,
      supersededBy: null,
      tags: ['architecture', 'storage'],
      related: ['fact-2024-12-01-xyz'],
      decayClass: 'slow',
      accessCount: 5,
      lastAccessed: '2025-01-15T00:00:00.000Z',
      projectId: 'proj-1',
    };

    it('converts camelCase MemoryFact to snake_case SQL params', () => {
      const params = factToParams(sampleFact);
      expect(params.id).toBe('fact-2025-01-01-abc1');
      expect(params.type).toBe('decision');
      expect(params.content).toBe('Use libSQL for storage');
      expect(params.confidence).toBe(0.9);
      expect(params.source_agent).toBe('claude');
      expect(params.source_operator).toBe('alice');
      expect(params.source_session).toBe('session-1');
      expect(params.valid_from).toBe('2025-01-01T00:00:00.000Z');
      expect(params.invalid_at).toBeNull();
      expect(params.ingested_at).toBe('2025-01-01T12:00:00.000Z');
      expect(params.invalidated_by).toBeNull();
      expect(params.superseded_by).toBeNull();
      expect(params.decay_class).toBe('slow');
      expect(params.access_count).toBe(5);
      expect(params.last_accessed).toBe('2025-01-15T00:00:00.000Z');
      expect(params.project_id).toBe('proj-1');
    });

    it('serializes tags array to JSON', () => {
      const params = factToParams(sampleFact);
      expect(params.tags).toBe('["architecture","storage"]');
    });

    it('serializes related array to JSON', () => {
      const params = factToParams(sampleFact);
      expect(params.related).toBe('["fact-2024-12-01-xyz"]');
    });

    it('round-trips through rowToFact', () => {
      const params = factToParams(sampleFact);
      // Simulate what the DB returns
      const row: FactRow = {
        id: params.id,
        type: params.type,
        content: params.content,
        confidence: params.confidence,
        source_agent: params.source_agent,
        source_operator: params.source_operator,
        source_session: params.source_session,
        valid_from: params.valid_from,
        invalid_at: params.invalid_at,
        ingested_at: params.ingested_at,
        invalidated_by: params.invalidated_by,
        superseded_by: params.superseded_by,
        tags: params.tags,
        related: params.related,
        decay_class: params.decay_class,
        access_count: params.access_count,
        last_accessed: params.last_accessed,
        project_id: params.project_id,
      };
      const restored = rowToFact(row);
      expect(restored).toEqual(sampleFact);
    });
  });
});
