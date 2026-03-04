/**
 * @domain subdomain: Agent Execution
 * @domain subdomain-type: core
 * @domain type: app-service
 * @domain layer: application
 * @domain emits: agent:started, agent:completed, agent:error
 * @domain depends: AgentOrchestrator, AgentStateTracker, AgentMessageHandler, ThreadManager, WSBroker, ThreadEventBus
 */

import { setLogSink } from '@funny/core';
import { AgentOrchestrator, defaultProcessFactory } from '@funny/core/agents';
import type { IAgentProcessFactory } from '@funny/core/agents';
import type {
  WSEvent,
  AgentProvider,
  AgentModel,
  PermissionMode,
  ThreadStatus,
} from '@funny/shared';
import { getResumeSystemPrefix } from '@funny/shared/thread-machine';
import type { ThreadEvent } from '@funny/shared/thread-machine';

import { log } from '../lib/logger.js';
import { AgentMessageHandler, type ProjectLookup } from './agent-message-handler.js';
import { AgentStateTracker } from './agent-state.js';
import * as pm from './project-manager.js';
import type { IThreadManager, IWSBroker } from './server-interfaces.js';
import { buildThreadContext, needsContextRecovery } from './thread-context-builder.js';
import { threadEventBus } from './thread-event-bus.js';
import * as tm from './thread-manager.js';
import { transitionStatus } from './thread-status-machine.js';
import { wsBroker } from './ws-broker.js';

// ── AgentRunner class ───────────────────────────────────────────

export class AgentRunner {
  private orchestrator: AgentOrchestrator;
  private state: AgentStateTracker;
  private messageHandler: AgentMessageHandler;

  constructor(
    private threadManager: IThreadManager,
    private wsBroker: IWSBroker,
    processFactory: IAgentProcessFactory,
    getProject?: ProjectLookup,
  ) {
    this.orchestrator = new AgentOrchestrator(processFactory);
    this.state = new AgentStateTracker();
    this.messageHandler = new AgentMessageHandler(this.state, threadManager, wsBroker, getProject);

    // Subscribe to orchestrator events — bridge to DB + WebSocket
    this.orchestrator.on('agent:message', (threadId: string, msg: any) => {
      this.messageHandler.handle(threadId, msg);
    });

    this.orchestrator.on('agent:error', (threadId: string, err: Error) => {
      log.error('Agent error', { namespace: 'agent', threadId, error: err.message });
      const currentStatus = this.threadManager.getThread(threadId)?.status ?? 'running';
      const { status } = transitionStatus(
        threadId,
        { type: 'FAIL', error: err.message },
        currentStatus as ThreadStatus,
      );
      this.threadManager.updateThread(threadId, { status, completedAt: new Date().toISOString() });
      this.emitWS(threadId, 'agent:error', { error: err.message });
      this.emitWS(threadId, 'agent:status', { status });
      this.emitAgentCompleted(threadId, status as 'completed' | 'failed' | 'stopped');
    });

    this.orchestrator.on('agent:unexpected-exit', (threadId: string) => {
      log.error('Agent exited unexpectedly', { namespace: 'agent', threadId });
      const currentStatus = this.threadManager.getThread(threadId)?.status ?? 'running';
      const { status } = transitionStatus(
        threadId,
        { type: 'FAIL' },
        currentStatus as ThreadStatus,
      );
      this.threadManager.updateThread(threadId, { status, completedAt: new Date().toISOString() });
      this.emitWS(threadId, 'agent:error', {
        error: 'Agent process exited unexpectedly without a result',
      });
      this.emitWS(threadId, 'agent:status', { status });
      this.emitAgentCompleted(threadId, status as 'completed' | 'failed' | 'stopped');
    });

    this.orchestrator.on('agent:stopped', (threadId: string) => {
      log.info('Agent stopped', { namespace: 'agent', threadId });
      const currentStatus = this.threadManager.getThread(threadId)?.status ?? 'running';
      const { status } = transitionStatus(
        threadId,
        { type: 'STOP' },
        currentStatus as ThreadStatus,
      );
      this.threadManager.updateThread(threadId, { status, completedAt: new Date().toISOString() });
      this.emitWS(threadId, 'agent:status', { status });
      this.emitAgentCompleted(threadId, 'stopped');
    });

    this.orchestrator.on('agent:session-cleared', (threadId: string) => {
      log.warn('Clearing stale sessionId after resume failure', { namespace: 'agent', threadId });
      this.threadManager.updateThread(threadId, { sessionId: null });
    });

    // Adopt surviving agent processes from a previous --watch restart.
    // globalThis.__funnyActiveAgents is set by the previous cleanup handler.
    const surviving = (globalThis as any).__funnyActiveAgents as Map<string, any> | undefined;
    if (surviving?.size) {
      let adopted = 0;
      for (const [threadId, proc] of surviving) {
        if (!proc.exited) {
          this.orchestrator.adoptProcess(threadId, proc);
          adopted++;
        } else {
          // Process exited during the transition — mark thread status
          log.info('Surviving agent already exited, skipping adoption', {
            namespace: 'agent',
            threadId,
          });
        }
      }
      if (adopted > 0) {
        log.info(`Adopted ${adopted} surviving agent(s) from previous instance`, {
          namespace: 'agent',
          count: adopted,
        });
      }
      delete (globalThis as any).__funnyActiveAgents;
    }
  }

  private emitWS(threadId: string, type: WSEvent['type'], data: unknown): void {
    const event = { type, threadId, data } as WSEvent;
    const thread = this.threadManager.getThread(threadId);
    const userId = thread?.userId;
    if (userId) {
      this.wsBroker.emitToUser(userId, event);
    } else {
      this.wsBroker.emit(event);
    }
  }

  /**
   * Emit agent:completed on the threadEventBus so reactive handlers
   * (e.g. git-status refresh) fire for stops/errors/unexpected exits,
   * not just natural completions from the NDJSON stream.
   */
  private emitAgentCompleted(threadId: string, status: 'completed' | 'failed' | 'stopped'): void {
    const thread = this.threadManager.getThread(threadId);
    if (!thread) return;
    const project = thread.projectId ? pm.getProject(thread.projectId) : undefined;
    threadEventBus.emit('agent:completed', {
      threadId,
      projectId: thread.projectId,
      userId: thread.userId ?? undefined,
      cwd: thread.worktreePath ?? project?.path ?? '',
      worktreePath: thread.worktreePath ?? null,
      status,
    });
  }

  // ── Public API ─────────────────────────────────────────────────

  async startAgent(
    threadId: string,
    prompt: string,
    cwd: string,
    model: AgentModel = 'sonnet',
    permissionMode: PermissionMode = 'autoEdit',
    images?: any[],
    disallowedTools?: string[],
    allowedTools?: string[],
    provider: AgentProvider = 'claude',
    mcpServers?: Record<string, any>,
    skipMessageInsert?: boolean,
  ): Promise<void> {
    log.info('startAgent called', {
      namespace: 'agent',
      threadId,
      model,
      permissionMode,
      provider,
      hasImages: !!images?.length,
      skipMessageInsert: !!skipMessageInsert,
      promptPreview: prompt.slice(0, 100),
    });

    // Clear stale DB-mapping state from previous runs
    this.state.clearRunState(threadId);

    // Transition the thread status via the state machine.
    // The machine picks the right event based on the current state, giving us
    // a `resumeReason` that tells us WHY we're entering `running` — so we can
    // choose the correct system prefix for the Claude session resume.
    const currentThread = this.threadManager.getThread(threadId);
    const currentStatus = (currentThread?.status ?? 'pending') as ThreadStatus;
    const startEvent = this.pickStartEvent(currentStatus);

    log.debug('startAgent state machine input', {
      namespace: 'agent',
      threadId,
      currentStatus,
      startEventType: startEvent.type,
      hasSessionId: !!currentThread?.sessionId,
    });

    const { status: newStatus, resumeReason } = transitionStatus(
      threadId,
      startEvent,
      currentStatus,
      currentThread?.cost ?? 0,
    );

    // Update thread status + provider in DB
    this.threadManager.updateThread(threadId, { status: newStatus, provider });

    // Save user message in DB (skip when a draft message already exists, e.g. idle threads)
    if (!skipMessageInsert) {
      this.threadManager.insertMessage({
        threadId,
        role: 'user',
        content: prompt,
        images: images ? JSON.stringify(images) : null,
        model,
        permissionMode,
      });
    }

    // Read session ID from DB for resume
    const thread = this.threadManager.getThread(threadId);

    // Check if this thread needs context recovery (post-merge, session exists but worktree gone)
    const needsRecovery = needsContextRecovery(threadId);
    let effectivePrompt = prompt;
    let effectiveSessionId = thread?.sessionId ?? undefined;

    if (needsRecovery) {
      log.info('Thread needs context recovery (post-merge)', { namespace: 'agent', threadId });
      // Build conversation history from DB
      const context = buildThreadContext(threadId);
      if (context) {
        // Prepend context to the user's new message
        effectivePrompt = `${context}\n\nUSER (new message):\n${prompt}`;
      }
      // Clear sessionId to force a fresh session with the full context
      this.threadManager.updateThread(threadId, { sessionId: null });
      effectiveSessionId = undefined;
    }

    // Derive the system prefix from the machine's resumeReason
    const isPostMerge = !!(thread?.sessionId && thread?.baseBranch && !thread?.worktreePath);
    const systemPrefix = getResumeSystemPrefix(resumeReason, isPostMerge);

    log.debug('startAgent resume context', {
      namespace: 'agent',
      threadId,
      newStatus,
      resumeReason: resumeReason ?? 'none',
      isPostMerge,
      needsRecovery: needsRecovery,
      effectiveSessionId: effectiveSessionId ?? 'none',
      systemPrefixPreview: systemPrefix ? systemPrefix.slice(0, 80) : 'none',
    });

    // When resuming a plan-mode thread, the orchestrator downgrades to autoEdit.
    // Sync the DB and notify the client so the PromptInput dropdown updates.
    const isPlanResume = thread?.sessionId && permissionMode === 'plan';
    if (isPlanResume) {
      this.threadManager.updateThread(threadId, { permissionMode: 'autoEdit' });
    }

    this.emitWS(threadId, 'agent:status', {
      status: 'running',
      ...(isPlanResume ? { permissionMode: 'autoEdit' as PermissionMode } : {}),
    });

    // Delegate lifecycle to orchestrator
    try {
      await this.orchestrator.startAgent({
        threadId,
        prompt: effectivePrompt,
        cwd,
        model,
        permissionMode,
        images,
        disallowedTools,
        allowedTools,
        provider,
        sessionId: effectiveSessionId,
        systemPrefix,
        mcpServers,
      });

      threadEventBus.emit('agent:started', {
        threadId,
        projectId: thread?.projectId ?? '',
        userId: thread?.userId ?? '',
        worktreePath: thread?.worktreePath ?? null,
        cwd,
        model,
        provider,
      });
    } catch (err: any) {
      log.error(`Failed to start ${provider} process`, {
        namespace: 'agent',
        threadId,
        error: err.message,
      });
      this.threadManager.updateThread(threadId, {
        status: 'failed',
        completedAt: new Date().toISOString(),
      });
      this.emitWS(threadId, 'agent:error', {
        error: err.message || `Failed to start ${provider} agent process`,
      });
      this.emitWS(threadId, 'agent:status', { status: 'failed' });
      throw err;
    }
  }

  /**
   * Pick the right machine event based on the current thread status.
   * This determines the `resumeReason` the machine will set.
   */
  private pickStartEvent(currentStatus: ThreadStatus): ThreadEvent {
    switch (currentStatus) {
      case 'pending':
        return { type: 'START' };
      case 'waiting':
        return { type: 'RESPOND' };
      case 'completed':
        return { type: 'FOLLOW_UP' };
      case 'stopped':
      case 'failed':
      case 'interrupted':
        return { type: 'RESTART' };
      case 'running':
        // Already running (self-transition)
        return { type: 'START' };
      default:
        return { type: 'START' };
    }
  }

  async stopAgent(threadId: string): Promise<void> {
    const thread = this.threadManager.getThread(threadId);
    if (thread?.provider === 'external') return;
    await this.orchestrator.stopAgent(threadId);
  }

  isAgentRunning(threadId: string): boolean {
    return this.orchestrator.isRunning(threadId);
  }

  /**
   * Clean up all in-memory state for a thread.
   * Call when deleting/archiving a thread.
   */
  cleanupThreadState(threadId: string): void {
    this.orchestrator.cleanupThread(threadId);
    this.state.cleanupThread(threadId);
  }

  /**
   * Kill all active agent processes. Called during server shutdown.
   */
  async stopAllAgents(): Promise<void> {
    await this.orchestrator.stopAll();
  }

  /**
   * Extract active agent processes WITHOUT killing them.
   * Used to preserve agents across bun --watch restarts.
   */
  extractActiveAgents(): Map<string, any> {
    return this.orchestrator.extractActiveAgents();
  }
}

// ── Default singleton (backward-compatible exports) ─────────────

const defaultRunner = new AgentRunner(tm, wsBroker, defaultProcessFactory);

export const startAgent = defaultRunner.startAgent.bind(defaultRunner);
export const stopAgent = defaultRunner.stopAgent.bind(defaultRunner);
export const stopAllAgents = defaultRunner.stopAllAgents.bind(defaultRunner);
export const isAgentRunning = defaultRunner.isAgentRunning.bind(defaultRunner);
export const cleanupThreadState = defaultRunner.cleanupThreadState.bind(defaultRunner);
export const extractActiveAgents = defaultRunner.extractActiveAgents.bind(defaultRunner);

// ── Bridge core debug logs to Winston/OTLP ──────────────────
setLogSink((level, namespace, message, data) => {
  const meta: Record<string, unknown> = { namespace: `core:${namespace}`, ...data };
  log[level](message, meta);
});

// ── Self-register with ShutdownManager ──────────────────────
import { shutdownManager, ShutdownPhase } from './shutdown-manager.js';
shutdownManager.register(
  'agent-runner',
  async (mode) => {
    if (mode === 'hotReload') {
      // Preserve running agents for adoption by the next instance
      const surviving = extractActiveAgents();
      if (surviving.size > 0) {
        (globalThis as any).__funnyActiveAgents = surviving;
        log.info(`Preserved ${surviving.size} agent(s) for next instance`, { namespace: 'agent' });
      } else {
        await stopAllAgents();
      }
    } else {
      await stopAllAgents();
    }
  },
  ShutdownPhase.SERVICES,
);
