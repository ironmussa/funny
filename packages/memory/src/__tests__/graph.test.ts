import { describe, it, expect, beforeEach } from 'vitest';

import { RelationshipGraph } from '../graph.js';
import { makeFact } from './helpers.js';

describe('RelationshipGraph', () => {
  let graph: RelationshipGraph;

  beforeEach(() => {
    graph = new RelationshipGraph();
  });

  // ─── Build from facts ─────────────────────────────

  describe('buildFromFacts', () => {
    it('builds empty graph from empty array', () => {
      graph.buildFromFacts([]);
      expect(graph.size()).toBe(0);
      expect(graph.edgeCount()).toBe(0);
    });

    it('creates nodes for all facts', () => {
      const facts = [
        makeFact({ id: 'a', related: [] }),
        makeFact({ id: 'b', related: [] }),
        makeFact({ id: 'c', related: [] }),
      ];
      graph.buildFromFacts(facts);
      expect(graph.size()).toBe(3);
    });

    it('creates bidirectional edges from related fields', () => {
      const facts = [makeFact({ id: 'a', related: ['b'] }), makeFact({ id: 'b', related: [] })];
      graph.buildFromFacts(facts);
      expect(graph.getRelated('a')).toContain('b');
      expect(graph.getRelated('b')).toContain('a');
      expect(graph.edgeCount()).toBe(1);
    });

    it('handles facts referencing non-existing related IDs', () => {
      const facts = [makeFact({ id: 'a', related: ['nonexistent'] })];
      graph.buildFromFacts(facts);
      expect(graph.size()).toBe(2); // 'a' + 'nonexistent' node
      expect(graph.getRelated('a')).toContain('nonexistent');
    });

    it('clears previous data on rebuild', () => {
      graph.buildFromFacts([makeFact({ id: 'a', related: ['b'] }), makeFact({ id: 'b' })]);
      expect(graph.size()).toBe(2);

      graph.buildFromFacts([makeFact({ id: 'x' })]);
      expect(graph.size()).toBe(1);
      expect(graph.getRelated('a')).toEqual([]);
    });
  });

  // ─── Edge mutations ────────────────────────────────

  describe('addEdge', () => {
    it('adds bidirectional edge', () => {
      graph.addEdge('a', 'b');
      expect(graph.getRelated('a')).toContain('b');
      expect(graph.getRelated('b')).toContain('a');
    });

    it('creates nodes if they do not exist', () => {
      graph.addEdge('x', 'y');
      expect(graph.size()).toBe(2);
    });

    it('does not duplicate edges', () => {
      graph.addEdge('a', 'b');
      graph.addEdge('a', 'b');
      expect(graph.edgeCount()).toBe(1);
    });
  });

  describe('removeEdge', () => {
    it('removes bidirectional edge', () => {
      graph.addEdge('a', 'b');
      graph.removeEdge('a', 'b');
      expect(graph.getRelated('a')).not.toContain('b');
      expect(graph.getRelated('b')).not.toContain('a');
    });

    it('is safe to call on non-existing edge', () => {
      expect(() => graph.removeEdge('x', 'y')).not.toThrow();
    });
  });

  describe('removeNode', () => {
    it('removes node and all its edges', () => {
      graph.addEdge('a', 'b');
      graph.addEdge('a', 'c');
      graph.addEdge('b', 'c');

      graph.removeNode('a');
      expect(graph.getRelated('a')).toEqual([]);
      expect(graph.getRelated('b')).not.toContain('a');
      expect(graph.getRelated('c')).not.toContain('a');
      // b-c edge should still exist
      expect(graph.getRelated('b')).toContain('c');
    });

    it('is safe to call on non-existing node', () => {
      expect(() => graph.removeNode('nonexistent')).not.toThrow();
    });
  });

  // ─── Traversal ─────────────────────────────────────

  describe('traverse', () => {
    it('returns empty set for isolated node', () => {
      graph.buildFromFacts([makeFact({ id: 'a', related: [] })]);
      const result = graph.traverse(['a']);
      expect(result.size).toBe(0);
    });

    it('finds direct neighbors (1 hop)', () => {
      graph.addEdge('a', 'b');
      graph.addEdge('a', 'c');
      const result = graph.traverse(['a'], 1);
      expect(result).toContain('b');
      expect(result).toContain('c');
      expect(result.size).toBe(2);
    });

    it('does NOT include seed IDs in result', () => {
      graph.addEdge('a', 'b');
      const result = graph.traverse(['a']);
      expect(result).not.toContain('a');
    });

    it('finds 2-hop neighbors', () => {
      // a -- b -- c -- d
      graph.addEdge('a', 'b');
      graph.addEdge('b', 'c');
      graph.addEdge('c', 'd');

      const result = graph.traverse(['a'], 2);
      expect(result).toContain('b');
      expect(result).toContain('c');
      expect(result).not.toContain('d'); // 3 hops away
    });

    it('handles multiple seeds', () => {
      // a -- b, c -- d
      graph.addEdge('a', 'b');
      graph.addEdge('c', 'd');

      const result = graph.traverse(['a', 'c'], 1);
      expect(result).toContain('b');
      expect(result).toContain('d');
    });

    it('handles cycles without infinite loop', () => {
      graph.addEdge('a', 'b');
      graph.addEdge('b', 'c');
      graph.addEdge('c', 'a');

      const result = graph.traverse(['a'], 10);
      expect(result).toContain('b');
      expect(result).toContain('c');
    });

    it('defaults to maxHops=2', () => {
      // a -- b -- c -- d
      graph.addEdge('a', 'b');
      graph.addEdge('b', 'c');
      graph.addEdge('c', 'd');

      const result = graph.traverse(['a']);
      expect(result).toContain('b');
      expect(result).toContain('c');
      expect(result).not.toContain('d');
    });
  });

  // ─── Metadata ──────────────────────────────────────

  describe('size and edgeCount', () => {
    it('counts nodes correctly', () => {
      graph.addEdge('a', 'b');
      graph.addEdge('c', 'd');
      expect(graph.size()).toBe(4);
    });

    it('counts edges correctly (bidirectional = 1)', () => {
      graph.addEdge('a', 'b');
      graph.addEdge('a', 'c');
      expect(graph.edgeCount()).toBe(2);
    });
  });
});
