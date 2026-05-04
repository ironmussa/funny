/**
 * Pure type definitions for the thread store.
 *
 * Lives in its own file so peers (`thread-store-internals`, `thread-ws-handlers`,
 * `lib/context-usage-storage`) can reference these shapes without importing
 * `thread-store.ts` — which would create a runtime import cycle.
 *
 * Only types belong here. No values, no side effects.
 */

import type {
  Thread,
  Message,
  ThreadEvent,
  WaitingReason,
  AgentModel,
  PermissionMode,
  ThreadStage,
} from '@funny/shared';

import type { ContextUsage } from '@/lib/context-usage-types';
import type { GitProgressStep } from '@/lib/git-progress-types';

export type { ContextUsage };

export interface AgentInitInfo {
  tools: string[];
  cwd: string;
  model: string;
}

export interface AgentResultInfo {
  status: 'completed' | 'failed';
  cost: number;
  duration: number;
  error?: string;
}

export interface CompactionEvent {
  trigger: 'manual' | 'auto';
  preTokens: number;
  timestamp: string;
}

export interface ThreadWithMessages extends Thread {
  messages: (Message & { toolCalls?: any[] })[];
  threadEvents?: ThreadEvent[];
  initInfo?: AgentInitInfo;
  resultInfo?: AgentResultInfo;
  waitingReason?: WaitingReason;
  pendingPermission?: { toolName: string; toolInput?: string };
  hasMore?: boolean;
  loadingMore?: boolean;
  contextUsage?: ContextUsage;
  compactionEvents?: CompactionEvent[];
  setupProgress?: GitProgressStep[];
  lastUserMessage?: Message & { toolCalls?: any[] };
  queuedCount?: number;
  queuedNextMessage?: string;
}

export interface ThreadState {
  threadsByProject: Record<string, Thread[]>;
  threadTotalByProject: Record<string, number>;
  selectedThreadId: string | null;
  activeThread: ThreadWithMessages | null;
  setupProgressByThread: Record<string, GitProgressStep[]>;
  contextUsageByThread: Record<string, ContextUsage>;
  queuedCountByThread: Record<string, number>;

  loadThreadsForProject: (projectId: string) => Promise<void>;
  loadMoreThreads: (projectId: string) => Promise<void>;
  selectThread: (threadId: string | null) => Promise<void>;
  archiveThread: (threadId: string, projectId: string) => Promise<void>;
  unarchiveThread: (threadId: string, projectId: string, stage: ThreadStage) => Promise<void>;
  renameThread: (threadId: string, projectId: string, title: string) => Promise<void>;
  pinThread: (threadId: string, projectId: string, pinned: boolean) => Promise<void>;
  updateThreadStage: (threadId: string, projectId: string, stage: ThreadStage) => Promise<void>;
  deleteThread: (threadId: string, projectId: string) => Promise<void>;
  appendOptimisticMessage: (
    threadId: string,
    content: string,
    images?: any[],
    model?: AgentModel,
    permissionMode?: PermissionMode,
    fileReferences?: { path: string; type?: 'file' | 'folder' }[],
  ) => void;
  rollbackOptimisticMessage: (threadId: string) => void;
  loadOlderMessages: () => Promise<void>;
  refreshActiveThread: () => Promise<void>;
  refreshAllLoadedThreads: () => Promise<void>;
  clearProjectThreads: (projectId: string) => void;

  sendMessage: (
    threadId: string,
    content: string,
    options?: {
      model?: AgentModel;
      permissionMode?: PermissionMode;
      images?: any[];
    },
  ) => Promise<boolean>;
  stopThread: (threadId: string) => Promise<void>;
  approveTool: (
    threadId: string,
    toolName: string,
    approved: boolean,
    allowedTools?: string[],
    disallowedTools?: string[],
    options?: { scope?: 'once' | 'always'; pattern?: string; toolInput?: string },
  ) => Promise<boolean>;
  searchThreadContent: (query: string, projectId?: string) => Promise<any>;

  handleWSInit: (threadId: string, data: AgentInitInfo) => void;
  handleWSMessage: (
    threadId: string,
    data: { messageId?: string; role: string; content: string },
  ) => void;
  handleWSToolCall: (
    threadId: string,
    data: { toolCallId?: string; messageId?: string; name: string; input: unknown },
  ) => void;
  handleWSToolOutput: (threadId: string, data: { toolCallId: string; output: string }) => void;
  handleWSStatus: (threadId: string, data: { status: string }) => void;
  handleWSError: (threadId: string, data: { error?: string }) => void;
  handleWSResult: (threadId: string, data: any) => void;
  handleWSQueueUpdate: (
    threadId: string,
    data: { threadId: string; queuedCount: number; nextMessage?: string },
  ) => void;
  handleWSCompactBoundary: (
    threadId: string,
    data: { trigger: 'manual' | 'auto'; preTokens: number; timestamp: string },
  ) => void;
  handleWSContextUsage: (
    threadId: string,
    data: { inputTokens: number; outputTokens: number; cumulativeInputTokens: number },
  ) => void;

  handleWSWorktreeSetup: (
    threadId: string,
    data: {
      step: string;
      label: string;
      status: 'running' | 'completed' | 'failed';
      error?: string;
    },
  ) => void;
  handleWSWorktreeSetupComplete: (
    threadId: string,
    data: { branch: string; worktreePath?: string },
  ) => void;
}
