/**
 * `ThreadState` — the Zustand store's full state + action surface.
 *
 * Lives in its own file (separate from `thread-store.ts`) so peer modules
 * — `thread-mutations`, `thread-select-helpers`, `thread-ws-handlers`,
 * `thread-types` — can reference the shape without importing `thread-store`,
 * which would close a cycle (those modules are imported by `thread-store`).
 */

import type { Thread, AgentModel, EffortLevel, PermissionMode, ThreadStage } from '@funny/shared';

import type {
  AgentInitInfo,
  CompactionEvent,
  ContextUsage,
  ThreadWithMessages,
} from './thread-types';

export interface ThreadState {
  // ── Single source of truth ─────────────────────────────────
  /** All known threads keyed by id. The only place a Thread row is stored. */
  threadsById: Record<string, Thread>;
  /** Per-project ordered IDs. Order matches the server response. */
  threadIdsByProject: Record<string, string[]>;
  /** Scratch threads (no project) — ordered, most recent first. */
  scratchThreadIds: string[];
  /** Pagination totals returned by the server. */
  threadTotalByProject: Record<string, number>;
  scratchThreadTotal: number;

  selectedThreadId: string | null;
  /**
   * The "thread gordo" map — payload (messages, toolCalls, threadEvents,
   * initInfo, contextUsage, …) for every thread that's currently visible
   * either in the right pane (anchored by `selectedThreadId`) or in a
   * live column (anchored by `registerLiveThread` refcount). Both surfaces
   * read and write through this single map; WS handlers patch it via
   * `mutations.applyThreadDataPatch`, which also mirrors the entry onto
   * `activeThread` when it matches `selectedThreadId`.
   */
  threadDataById: Record<string, ThreadWithMessages>;
  /**
   * Derived mirror of `threadDataById[selectedThreadId]`. Kept in sync by
   * the mutation helpers in `thread-mutations.ts` so legacy consumers that
   * read `s.activeThread` keep working. New code should prefer
   * `useActiveThread()` / `getActiveThread(state)` from this module.
   * @deprecated read from `threadDataById[selectedThreadId]` directly.
   */
  activeThread: ThreadWithMessages | null;
  /** Setup progress keyed by threadId — survives thread switches */
  setupProgressByThread: Record<string, import('@/components/GitProgressModal').GitProgressStep[]>;
  /** Context usage keyed by threadId — survives thread switches */
  contextUsageByThread: Record<string, ContextUsage>;
  /** Queued message count keyed by threadId — survives thread switches */
  queuedCountByThread: Record<string, number>;

  loadThreadsForProject: (projectId: string, includeArchived?: boolean) => Promise<void>;
  /** Load the current user's scratch threads. */
  loadScratchThreads: () => Promise<void>;
  /** Add a freshly created scratch thread to the local cache. */
  addScratchThread: (thread: Thread) => void;
  /** Load the next page of threads for a project (appends to existing list) */
  loadMoreThreads: (projectId: string, includeArchived?: boolean) => Promise<void>;
  selectThread: (threadId: string | null) => Promise<void>;
  /**
   * Warm the prefetch cache for a thread (e.g. on hover) so the subsequent
   * selectThread call can resolve from cache instead of awaiting the network.
   * No-op if already cached or if the thread is currently active.
   */
  prefetchThread: (threadId: string) => void;
  archiveThread: (threadId: string, projectId: string) => Promise<void>;
  unarchiveThread: (threadId: string, projectId: string, stage: ThreadStage) => Promise<void>;
  renameThread: (threadId: string, projectId: string, title: string) => Promise<void>;
  pinThread: (threadId: string, projectId: string, pinned: boolean) => Promise<void>;
  updateThreadStage: (threadId: string, projectId: string, stage: ThreadStage) => Promise<void>;
  deleteThread: (threadId: string, projectId: string) => Promise<void>;
  /** Delete a scratch thread (no project / no worktree). */
  deleteScratchThread: (threadId: string) => Promise<void>;
  appendOptimisticMessage: (
    threadId: string,
    content: string,
    images?: any[],
    model?: AgentModel,
    permissionMode?: PermissionMode,
    fileReferences?: { path: string; type?: 'file' | 'folder' }[],
    effort?: EffortLevel,
  ) => void;
  rollbackOptimisticMessage: (threadId: string) => void;
  loadOlderMessages: () => Promise<void>;
  /**
   * Load older message pages for a thread until the given message id is
   * present in the loaded window (or there is nothing left to load).
   * Returns true when the message ended up loaded. Used by in-thread search
   * to navigate to matches that live in not-yet-paginated history.
   */
  loadMessagesUntil: (threadId: string, messageId: string) => Promise<boolean>;
  refreshActiveThread: () => Promise<void>;
  refreshAllLoadedThreads: () => Promise<void>;
  clearProjectThreads: (projectId: string) => void;

  // Agent lifecycle actions — centralize API calls that components previously made directly
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

  // Thread data registration (for LiveColumnsView and any future surface
  // that needs to keep a thread hydrated outside the right pane).
  registerLiveThread: (threadId: string) => Promise<void>;
  unregisterLiveThread: (threadId: string) => void;

  // WebSocket event handlers
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
  handleWSStageChanged: (
    threadId: string,
    data: { fromStage: ThreadStage | null; toStage: ThreadStage; projectId: string },
  ) => void;
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

  // Worktree setup progress handlers
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
