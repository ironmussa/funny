/**
 * @domain subdomain: Memory System (Paisley Park)
 * @domain subdomain-type: core
 * @domain type: app-service
 * @domain layer: application
 *
 * Retrieval engine: orchestrates embedding search, keyword search,
 * graph traversal, and ranking to produce the most relevant facts.
 */

import type { MemoryFact, MemoryScope, RecallOptions, SearchFilters } from '@funny/shared';

import { RelationshipGraph } from './graph.js';
import { listFacts, readFact } from './storage.js';
import { calculateDecayScore, isCurrentlyValid, wasValidAt } from './temporal.js';
import { frontmatterToApi, type MemoryFactFile } from './types.js';
import { VectorIndex } from './vector-index.js';

// ─── Scored fact for ranking ────────────────────────────

interface ScoredFact {
  fact: MemoryFact;
  score: number;
  source: 'embedding' | 'keyword' | 'graph';
}

// ─── Retrieval engine ───────────────────────────────────

export class RetrievalEngine {
  constructor(
    private readonly memoryDir: string,
    private readonly vectorIndex: VectorIndex,
    private readonly graph: RelationshipGraph,
  ) {}

  // ─── Main recall ────────────────────────────────────

  async recall(query: string, options: RecallOptions = {}): Promise<MemoryFact[]> {
    const {
      limit = 10,
      scope = 'all',
      includeInvalidated = false,
      minConfidence = 0.5,
      asOf,
    } = options;

    // 1. Load all facts from relevant directories
    const allFacts = await this.loadFacts(scope);

    // 2. Run embedding search and keyword search in parallel
    const [embeddingResults, keywordResults] = await Promise.all([
      this.embeddingSearch(query, allFacts, limit * 3),
      this.keywordSearch(query, allFacts, limit * 3),
    ]);

    // 3. Merge results with weighted scoring
    const merged = this.mergeResults(embeddingResults, keywordResults);

    // 4. Graph traversal from top results to discover related facts
    const topIds = merged.slice(0, Math.min(5, merged.length)).map((s) => s.fact.id);
    const graphIds = this.graph.traverse(topIds, 2);
    const graphFacts = await this.loadFactsByIds(graphIds, allFacts);
    for (const gf of graphFacts) {
      if (!merged.some((m) => m.fact.id === gf.id)) {
        merged.push({ fact: gf, score: 0.3, source: 'graph' }); // lower weight for graph-only
      }
    }

    // 5. Apply ranking: temporal filter, decay, confidence, dedup
    const ranked = this.rank(merged, {
      includeInvalidated,
      minConfidence,
      asOf: asOf ? new Date(asOf) : undefined,
    });

    // 6. Return top-K
    return ranked.slice(0, limit);
  }

  // ─── Search (explicit, no graph traversal) ──────────

  async search(query: string, filters: SearchFilters = {}): Promise<MemoryFact[]> {
    const allFacts = await this.loadFacts('all');

    const [embeddingResults, keywordResults] = await Promise.all([
      this.embeddingSearch(query, allFacts, 50),
      this.keywordSearch(query, allFacts, 50),
    ]);

    let merged = this.mergeResults(embeddingResults, keywordResults);

    // Apply filters
    merged = merged.filter((s) => {
      const f = s.fact;

      if (filters.type) {
        const types = Array.isArray(filters.type) ? filters.type : [filters.type];
        if (!types.includes(f.type)) return false;
      }

      if (filters.tags?.length) {
        if (!filters.tags.some((t) => f.tags.includes(t))) return false;
      }

      if (filters.sourceAgent && f.sourceAgent !== filters.sourceAgent) return false;

      if (filters.minConfidence && f.confidence < filters.minConfidence) return false;

      if (filters.validAt) {
        const validAt = new Date(filters.validAt);
        const validFrom = new Date(f.validFrom);
        if (validAt < validFrom) return false;
        if (f.invalidAt && validAt >= new Date(f.invalidAt)) return false;
      }

      if (filters.createdAfter && new Date(f.ingestedAt) < new Date(filters.createdAfter))
        return false;

      if (filters.createdBefore && new Date(f.ingestedAt) > new Date(filters.createdBefore))
        return false;

      return true;
    });

    return merged.map((s) => s.fact);
  }

  // ─── Timeline ───────────────────────────────────────

  async timeline(
    options: {
      from?: string;
      to?: string;
      type?: string | string[];
      includeInvalidated?: boolean;
    } = {},
  ): Promise<MemoryFact[]> {
    const allFacts = await this.loadFacts('all');
    let facts = allFacts.map((f) => frontmatterToApi(f.frontmatter, f.content));

    if (!options.includeInvalidated) {
      facts = facts.filter((f) => f.invalidAt === null);
    }

    if (options.type) {
      const types = Array.isArray(options.type) ? options.type : [options.type];
      facts = facts.filter((f) => types.includes(f.type));
    }

    if (options.from) {
      const from = new Date(options.from);
      facts = facts.filter((f) => new Date(f.validFrom) >= from);
    }

    if (options.to) {
      const to = new Date(options.to);
      facts = facts.filter((f) => new Date(f.validFrom) <= to);
    }

    // Sort chronologically
    facts.sort((a, b) => new Date(a.validFrom).getTime() - new Date(b.validFrom).getTime());

    return facts;
  }

  // ─── Private: embedding search ──────────────────────

  private async embeddingSearch(
    query: string,
    allFacts: MemoryFactFile[],
    topK: number,
  ): Promise<ScoredFact[]> {
    if (!this.vectorIndex.isAvailable()) return [];

    const results = await this.vectorIndex.searchSimilar(query, topK);
    if (results.isErr()) return [];

    const factMap = new Map(allFacts.map((f) => [f.frontmatter.id, f]));
    return results.value
      .filter((r) => factMap.has(r.factId))
      .map((r) => {
        const f = factMap.get(r.factId)!;
        return {
          fact: frontmatterToApi(f.frontmatter, f.content),
          score: r.score,
          source: 'embedding' as const,
        };
      });
  }

  // ─── Private: keyword search ────────────────────────

  private async keywordSearch(
    query: string,
    allFacts: MemoryFactFile[],
    topK: number,
  ): Promise<ScoredFact[]> {
    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 2);
    if (terms.length === 0) return [];

    const scored: ScoredFact[] = [];
    for (const fact of allFacts) {
      const content = fact.content.toLowerCase();
      const tags = fact.frontmatter.tags.map((t) => t.toLowerCase());
      const allText = `${content} ${tags.join(' ')}`;

      let matchCount = 0;
      for (const term of terms) {
        if (allText.includes(term)) matchCount++;
      }

      if (matchCount > 0) {
        const score = matchCount / terms.length;
        scored.push({
          fact: frontmatterToApi(fact.frontmatter, fact.content),
          score,
          source: 'keyword',
        });
      }
    }

    return scored.sort((a, b) => b.score - a.score).slice(0, topK);
  }

  // ─── Private: merge results ─────────────────────────

  private mergeResults(embeddingResults: ScoredFact[], keywordResults: ScoredFact[]): ScoredFact[] {
    const factMap = new Map<string, ScoredFact>();

    // Embedding results weighted 0.7
    for (const r of embeddingResults) {
      factMap.set(r.fact.id, {
        ...r,
        score: r.score * 0.7,
      });
    }

    // Keyword results weighted 0.3 — add to existing or create new
    for (const r of keywordResults) {
      const existing = factMap.get(r.fact.id);
      if (existing) {
        existing.score += r.score * 0.3;
      } else {
        factMap.set(r.fact.id, {
          ...r,
          score: r.score * 0.3,
        });
      }
    }

    return Array.from(factMap.values()).sort((a, b) => b.score - a.score);
  }

  // ─── Private: ranking ───────────────────────────────

  private rank(
    scored: ScoredFact[],
    options: { includeInvalidated: boolean; minConfidence: number; asOf?: Date },
  ): MemoryFact[] {
    const now = new Date();

    return scored
      .filter((s) => {
        const f = s.fact;

        // Confidence filter
        if (f.confidence < options.minConfidence) return false;

        // Temporal filter
        if (!options.includeInvalidated && f.invalidAt !== null) return false;

        // Point-in-time filter
        if (options.asOf) {
          const validFrom = new Date(f.validFrom);
          if (options.asOf < validFrom) return false;
          if (f.invalidAt && options.asOf >= new Date(f.invalidAt)) return false;
        }

        return true;
      })
      .map((s) => {
        // Apply decay to score
        const decayScore = calculateDecayScore(
          {
            last_accessed: s.fact.lastAccessed,
            decay_class: s.fact.decayClass,
          } as any,
          now,
        );
        return {
          ...s,
          score: s.score * (0.6 + 0.4 * decayScore), // Decay adjusts up to 40% of relevance score
        };
      })
      .sort((a, b) => b.score - a.score)
      .map((s) => s.fact);
  }

  // ─── Private: load facts ────────────────────────────

  private async loadFacts(scope: MemoryScope): Promise<MemoryFactFile[]> {
    const dirs: string[] = [];

    switch (scope) {
      case 'project':
        dirs.push('project/facts');
        break;
      case 'operator':
        dirs.push('operators');
        break;
      case 'team':
        dirs.push('team');
        break;
      case 'all':
        dirs.push('project/facts');
        break;
    }

    const allFacts: MemoryFactFile[] = [];
    for (const dir of dirs) {
      const result = await listFacts(this.memoryDir, dir);
      if (result.isOk()) {
        allFacts.push(...result.value);
      }
    }

    return allFacts;
  }

  private async loadFactsByIds(
    ids: Set<string>,
    allFacts: MemoryFactFile[],
  ): Promise<MemoryFact[]> {
    const factMap = new Map(allFacts.map((f) => [f.frontmatter.id, f]));
    const result: MemoryFact[] = [];

    for (const id of ids) {
      const f = factMap.get(id);
      if (f) {
        result.push(frontmatterToApi(f.frontmatter, f.content));
      }
    }

    return result;
  }
}
