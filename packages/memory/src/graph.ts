/**
 * @domain subdomain: Memory System (Paisley Park)
 * @domain subdomain-type: core
 * @domain type: domain-service
 * @domain layer: domain
 *
 * In-memory bidirectional adjacency graph for fact relationships.
 * Built from the `related` field in each fact.
 * Supports BFS traversal to find related facts up to N hops.
 */

import type { MemoryFact } from './types.js';

export class RelationshipGraph {
  /** fact_id → Set<related_fact_id> */
  private adjacency = new Map<string, Set<string>>();

  // ─── Build from facts ──────────────────────────────

  buildFromFacts(facts: MemoryFact[]) {
    this.adjacency.clear();

    for (const fact of facts) {
      const id = fact.id;
      if (!this.adjacency.has(id)) {
        this.adjacency.set(id, new Set());
      }

      for (const related of fact.related) {
        // Bidirectional
        this.adjacency.get(id)!.add(related);
        if (!this.adjacency.has(related)) {
          this.adjacency.set(related, new Set());
        }
        this.adjacency.get(related)!.add(id);
      }
    }
  }

  // ─── Graph mutations ────────────────────────────────

  addEdge(factA: string, factB: string) {
    if (!this.adjacency.has(factA)) this.adjacency.set(factA, new Set());
    if (!this.adjacency.has(factB)) this.adjacency.set(factB, new Set());
    this.adjacency.get(factA)!.add(factB);
    this.adjacency.get(factB)!.add(factA);
  }

  removeEdge(factA: string, factB: string) {
    this.adjacency.get(factA)?.delete(factB);
    this.adjacency.get(factB)?.delete(factA);
  }

  removeNode(factId: string) {
    const neighbors = this.adjacency.get(factId);
    if (neighbors) {
      for (const n of neighbors) {
        this.adjacency.get(n)?.delete(factId);
      }
    }
    this.adjacency.delete(factId);
  }

  // ─── Traversal ──────────────────────────────────────

  /**
   * BFS from seed fact IDs, returning all related fact IDs
   * up to maxHops away (default 2).
   * Does NOT include the seed IDs themselves in the result.
   */
  traverse(seedIds: string[], maxHops: number = 2): Set<string> {
    const visited = new Set<string>();
    const result = new Set<string>();
    const queue: Array<{ id: string; depth: number }> = [];

    // Enqueue seeds
    for (const id of seedIds) {
      visited.add(id);
      queue.push({ id, depth: 0 });
    }

    while (queue.length > 0) {
      const { id, depth } = queue.shift()!;
      const neighbors = this.adjacency.get(id);
      if (!neighbors || depth >= maxHops) continue;

      for (const neighbor of neighbors) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          result.add(neighbor);
          queue.push({ id: neighbor, depth: depth + 1 });
        }
      }
    }

    return result;
  }

  /**
   * Get direct neighbors of a fact.
   */
  getRelated(factId: string): string[] {
    return Array.from(this.adjacency.get(factId) ?? []);
  }

  /**
   * Get total number of nodes in the graph.
   */
  size(): number {
    return this.adjacency.size;
  }

  /**
   * Get total number of edges in the graph.
   */
  edgeCount(): number {
    let count = 0;
    for (const neighbors of this.adjacency.values()) {
      count += neighbors.size;
    }
    return count / 2; // bidirectional = each edge counted twice
  }
}
