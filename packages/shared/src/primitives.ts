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
  | 'cursor'
  | 'deepagent'
  | 'llm-api'
  | 'external';

/**
 * funny's permission modes (provider-agnostic surface).
 *
 * Each provider adapter maps these to its own native modes:
 *
 *   funny          | claude SDK           | gemini-cli         | codex          | cursor (ACP)
 *   ───────────────┼──────────────────────┼────────────────────┼────────────────┼──────────────
 *   plan           | plan                 | plan               | read-only      | plan
 *   ask            | default              | default            | ask-on-request | ask
 *   confirmEdit    | default              | default            | ask-on-request | agent + prompt
 *   autoEdit       | bypassPermissions    | yolo (--yolo)      | full-access    | agent + auto
 *   auto           | auto (classifier)    | (n/a — Claude-only)| (n/a)          | (n/a)
 *
 * NAMING TRAP: funny's `autoEdit` is FULL BYPASS (≡ Claude `bypassPermissions`,
 * Gemini `yolo`). It is NOT the same as Claude `acceptEdits` or Gemini
 * `auto_edit`, which only auto-accept file edits but still prompt on shell.
 * funny does not currently expose an "auto-edit, prompt-on-shell" mode.
 *
 * `auto` is Claude-only (LLM classifier guards each tool call). The client
 * filters it out for non-Claude providers — see use-prompt-input-state.ts.
 */
export type PermissionMode = 'plan' | 'auto' | 'autoEdit' | 'confirmEdit' | 'ask';
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type FollowUpMode = 'interrupt' | 'queue' | 'steer';

// ─── Resume reason (used by thread-machine + types barrel) ────
export type ResumeReason =
  | 'fresh' // First start, no session to resume
  | 'waiting-response' // User responded to question/plan/permission
  | 'interrupted' // Genuine resume after stop/fail/interrupt
  | 'follow-up' // New message sent after agent completed
  | 'post-merge' // Follow-up after worktree merge
  | null; // Unknown / not set
