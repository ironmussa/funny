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

export interface Thread {
  id: string;
  projectId: string;
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
  /** Filled template variable values (key → value). */
  templateVariables?: Record<string, string>;
}

export interface PaginatedThreadsResponse {
  threads: Thread[];
  total: number;
  hasMore: boolean;
}
