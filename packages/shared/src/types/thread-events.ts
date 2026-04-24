// ─── Thread Events ──────────────────────────────────────

export type ThreadEventType =
  | 'git:changed'
  | 'git:commit'
  | 'git:push'
  | 'git:merge'
  | 'git:pr_created'
  | 'git:stage'
  | 'git:unstage'
  | 'git:revert'
  | 'git:pull'
  | 'git:stash'
  | 'git:stash_pop'
  | 'git:reset_soft'
  | 'compact_boundary'
  | 'workflow:started'
  | 'workflow:completed'
  | 'workflow:hooks'
  | 'workflow:review'
  | 'workflow:fix'
  | 'workflow:precommit_fix'
  | 'pipeline:started'
  | 'pipeline:reviewer_started'
  | 'pipeline:review_verdict'
  | 'pipeline:corrector_started'
  | 'pipeline:fix_applied'
  | 'pipeline:completed'
  | 'pipeline:precommit_hooks'
  | 'pipeline:precommit_fixer_started'
  | 'pipeline:precommit_fixing'
  | 'pipeline:precommit_fixed'
  | 'pipeline:precommit_failed';

export interface ThreadEvent {
  id: string;
  threadId: string;
  type: ThreadEventType;
  data: string;
  createdAt: string;
}
