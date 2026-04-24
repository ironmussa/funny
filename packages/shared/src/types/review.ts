// ─── Code Review (ReviewBot) ────────────────────────────

export type ReviewFindingSeverity = 'critical' | 'high' | 'medium' | 'low' | 'suggestion';
export type ReviewFindingCategory =
  | 'bug'
  | 'security'
  | 'performance'
  | 'style'
  | 'logic'
  | 'maintainability';

export interface CodeReviewFinding {
  severity: ReviewFindingSeverity;
  category: ReviewFindingCategory;
  file: string;
  line?: number;
  description: string;
  suggestion?: string;
}

export interface CodeReviewResult {
  prNumber: number;
  status: 'approved' | 'changes_requested' | 'commented';
  summary: string;
  findings: CodeReviewFinding[];
  duration_ms: number;
  model: string;
}

export interface TriggerReviewRequest {
  prNumber: number;
  model?: string;
  provider?: string;
}
