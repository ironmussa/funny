/**
 * Complexity level descriptions:
 * 1 — Single-session fact extraction (simple semantic search)
 * 2 — Multi-session reasoning (requires info from multiple sessions)
 * 3 — Knowledge update (facts change across sessions, must use latest)
 * 4 — Temporal reasoning (time-dependent queries)
 * 5 — Abstention (question cannot be answered from memory)
 */
export type ComplexityLevel = 1 | 2 | 3 | 4 | 5;

export interface LongMemSession {
  session_id: string;
  turns: LongMemTurn[];
  timestamp?: string;
}

export interface LongMemTurn {
  speaker: string;
  text: string;
}

export interface LongMemQuestion {
  question_id: string;
  question: string;
  answer: string;
  level: ComplexityLevel;
  /** For level 5 (abstention): the expected behavior is to say "I don't know" */
  requires_abstention?: boolean;
  /** Session IDs containing relevant information */
  relevant_sessions?: string[];
}

export interface LongMemEvalDataset {
  /** Dataset size variant */
  size: 'S' | 'M' | 'L';
  sessions: LongMemSession[];
  questions: LongMemQuestion[];
  totalTokens: number;
}
