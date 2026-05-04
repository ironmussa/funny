/**
 * Primitive shared types — small unions and enums consumed across the
 * package. Lives outside `types.ts` so that sub-modules (`thread-machine`,
 * `models`, `types/automations`, `types/pipelines`, `types/agent-templates`)
 * can depend on these primitives without forming an import cycle through
 * the `types.ts` barrel.
 *
 * RULE: only put pure primitives (string-literal unions, plain enums) here.
 * No imports from `./types.js` or any sub-module. No runtime values.
 */

// ─── Threads ────────────────────────────────────────────
export type ThreadMode = 'local' | 'worktree';
export type ThreadRuntime = 'local' | 'remote';
export type ThreadStatus =
  | 'setting_up'
  | 'idle'
  | 'pending'
  | 'running'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'stopped'
  | 'interrupted';
export type ThreadStage = 'backlog' | 'planning' | 'in_progress' | 'review' | 'done' | 'archived';
export type WaitingReason = 'question' | 'plan' | 'permission';
export type ThreadSource = 'web' | 'chrome_extension' | 'api' | 'automation' | 'ingest';

// ─── Agent ──────────────────────────────────────────────
export type AgentProvider =
  | 'claude'
  | 'codex'
  | 'gemini'
  | 'pi'
  | 'deepagent'
  | 'llm-api'
  | 'external';

export type PermissionMode = 'plan' | 'auto' | 'autoEdit' | 'confirmEdit' | 'ask';
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type FollowUpMode = 'interrupt' | 'queue' | 'ask';

// ─── Resume reason (used by thread-machine + types barrel) ────
export type ResumeReason =
  | 'fresh' // First start, no session to resume
  | 'waiting-response' // User responded to question/plan/permission
  | 'interrupted' // Genuine resume after stop/fail/interrupt
  | 'follow-up' // New message sent after agent completed
  | 'post-merge' // Follow-up after worktree merge
  | null; // Unknown / not set
