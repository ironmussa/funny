// ─── Paisley Park (Project Memory) ──────────────────────

export type FactType = 'decision' | 'bug' | 'pattern' | 'convention' | 'insight' | 'context';

export type DecayClass = 'slow' | 'normal' | 'fast';

export type MemoryScope = 'project' | 'operator' | 'team' | 'all';

export interface MemoryFact {
  id: string;
  type: FactType;
  confidence: number;
  sourceAgent: string | null;
  sourceOperator: string | null;
  sourceSession: string | null;
  validFrom: string; // ISO 8601
  invalidAt: string | null;
  ingestedAt: string; // ISO 8601
  invalidatedBy: string | null;
  supersededBy: string | null;
  tags: string[];
  related: string[];
  decayClass: DecayClass;
  accessCount: number;
  lastAccessed: string; // ISO 8601
  content: string;
}

export interface RecallOptions {
  limit?: number;
  scope?: MemoryScope;
  includeInvalidated?: boolean;
  minConfidence?: number;
  asOf?: string; // ISO 8601
  forOperator?: string;
}

export interface AddOptions {
  type: FactType;
  tags?: string[];
  confidence?: number;
  decayClass?: DecayClass;
  relatedTo?: string[];
  validFrom?: string; // ISO 8601
  scope?: MemoryScope;
  sourceAgent?: string;
  sourceOperator?: string;
  sourceSession?: string;
}

export interface SearchFilters {
  type?: FactType | FactType[];
  tags?: string[];
  sourceAgent?: string;
  validAt?: string; // ISO 8601
  createdAfter?: string; // ISO 8601
  createdBefore?: string; // ISO 8601
  minConfidence?: number;
}

export interface TimelineOptions {
  from?: string; // ISO 8601
  to?: string; // ISO 8601
  type?: FactType | FactType[];
  includeInvalidated?: boolean;
}

export interface MemoryRecallResult {
  facts: MemoryFact[];
  formattedContext: string;
  totalFound: number;
}
