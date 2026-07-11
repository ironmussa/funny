import type { AgentModel } from '../models.js';
import type {
  AgentProvider,
  PermissionMode,
  ThreadMode,
  ThreadRuntime,
  ThreadSource,
  ThreadStage,
  ThreadStatus,
} from '../primitives.js';
import type { ThreadResolvedAgentProfileSnapshot } from './agent-execution-profiles.js';

export interface Thread {
  id: string;
  /**
   * Empty string `''` for scratch threads (no project). The DB column is
   * nullable; the runtime maps null → '' at the boundary. See design D1.
   */
  projectId: string;
  /**
   * True when this is a lightweight projectless thread.
   * Optional at the type level so existing thread factories/fixtures don't
   * all need updating, but the DB column is NOT NULL with default 0 — the
   * value is always present at runtime. Use `canDoGitOps(thread)` instead
   * of reading this directly. See scratch-threads/design.md (D1).
   */
  isScratch?: boolean;
  userId: string;
  title: string;
  mode: ThreadMode;
  status: ThreadStatus;
  stage: ThreadStage;
  provider: AgentProvider;
  permissionMode: PermissionMode;
  model: AgentModel;
  branch?: string;
  baseBranch?: string;
  worktreePath?: string;
  sessionId?: string;
  initialPrompt?: string;
  cost: number;
  archived?: boolean;
  pinned?: boolean;
  /** When true, the scheduler may auto-claim and dispatch this thread. */
  schedulerManaged?: boolean;
  automationId?: string;
  source: ThreadSource;
  externalRequestId?: string;
  parentThreadId?: string;
  designId?: string;
  runtime: ThreadRuntime;
  containerUrl?: string;
  containerName?: string;
  commentCount?: number;
  /** Why context recovery is needed (e.g. model/provider changed mid-thread) */
  contextRecoveryReason?: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  /** Creator/agent that generated this thread (user ID, 'external', 'pipeline', 'automation', etc.) */
  createdBy?: string;
  /** Snippet of the last assistant message (populated in list queries) */
  lastAssistantMessage?: string;
  /** Agent template used to configure this thread (Deep Agent only). */
  agentTemplateId?: string;
  /** Execution profile snapshot used when this thread was last started. */
  agentProfile?: ThreadResolvedAgentProfileSnapshot | null;
  agentProfileId?: string | null;
  agentProfileName?: string | null;
  agentProfileProvider?: AgentProvider | null;
  /** Filled template variable values (key → value). */
  templateVariables?: Record<string, string>;
  /**
   * Whether the thread can restore file checkpoints. Claude uses its native
   * SDK checkpoints; Codex uses local Git checkpoints captured before turns.
   */
  fileCheckpointingEnabled?: boolean;
  /**
   * The VIEWER's own share level on this thread, populated only by the
   * single-thread fetch (`GET /threads/:id`). `null`/undefined when the viewer
   * is the owner (not a sharee). `'steer'` unlocks follow-ups + git read for a
   * non-owner. See `thread-sharing-steer`. Use the `canSteerShare` /
   * `canViewGitShare` predicates in `thread-variant.ts`, not this field directly.
   */
  viewerShareLevel?: 'view' | 'comment' | 'steer' | null;
}

export interface PaginatedThreadsResponse {
  threads: Thread[];
  total: number;
  hasMore: boolean;
}
