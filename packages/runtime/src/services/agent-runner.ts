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
import { setMemoryLogSink } from '@funny/memory';
import { getPaisleyPark } from '@funny/memory';
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
import { metric, startSpan, setThreadTrace, clearThreadTrace } from '../lib/telemetry.js';
import { AgentMessageHandler, type ProjectLookup } from './agent-message-handler.js';
import { AgentStateTracker } from './agent-state.js';
import type { IThreadManager, IWSBroker } from './server-interfaces.js';
import { getServices } from './service-registry.js';
import { buildThreadContext, needsContextRecovery } from './thread-context-builder.js';
import { threadEventBus } from './thread-event-bus.js';
import { transitionStatus } from './thread-status-machine.js';
import { wsBroker } from './ws-broker.js';

// ── AgentRunner class ───────────────────────────────────────────

export class AgentRunner {
  private orchestrator: AgentOrchestrator;
  private state: AgentStateTracker;
  private messageHandler: AgentMessageHandler;
  private runSpans = new Map<string, ReturnType<typeof startSpan>>();

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
      void (async () => {
        await this.messageHandler.handle(threadId, msg);
        metric('agent.messages', 1, { type: 'sum', attributes: { threadId } });
      })();
    });

    this.orchestrator.on('agent:error', (threadId: string, err: Error) => {
      void (async () => {
        log.error('Agent error', { namespace: 'agent', threadId, error: err.message });
        this.endRunSpan(threadId, 'error', err.message);
        const thread = await this.threadManager.getThread(threadId);
        const currentStatus = thread?.status ?? 'running';
        const { status } = transitionStatus(
          threadId,
          { type: 'FAIL', error: err.message },
          currentStatus as ThreadStatus,
        );
        await this.threadManager.updateThread(threadId, {
          status,
          completedAt: new Date().toISOString(),
        });
        await this.emitWS(threadId, 'agent:error', { error: err.message });
        await this.emitWS(threadId, 'agent:status', { status });
        await this.emitAgentCompleted(threadId, status as 'completed' | 'failed' | 'stopped');
      })();
    });

    this.orchestrator.on('agent:unexpected-exit', (threadId: string) => {
      void (async () => {
        log.error('Agent exited unexpectedly', { namespace: 'agent', threadId });
        this.endRunSpan(threadId, 'error', 'unexpected exit');
        const thread = await this.threadManager.getThread(threadId);
        const currentStatus = thread?.status ?? 'running';
        const { status } = transitionStatus(
          threadId,
          { type: 'FAIL' },
          currentStatus as ThreadStatus,
        );
        await this.threadManager.updateThread(threadId, {
          status,
          completedAt: new Date().toISOString(),
        });
        await this.emitWS(threadId, 'agent:error', {
          error: 'Agent process exited unexpectedly without a result',
        });
        await this.emitWS(threadId, 'agent:status', { status });
        await this.emitAgentCompleted(threadId, status as 'completed' | 'failed' | 'stopped');
      })();
    });

    this.orchestrator.on('agent:stopped', (threadId: string) => {
      void (async () => {
        log.info('Agent stopped', { namespace: 'agent', threadId });
        this.endRunSpan(threadId, 'ok');
        const thread = await this.threadManager.getThread(threadId);
        const currentStatus = thread?.status ?? 'running';
        const { status } = transitionStatus(
          threadId,
          { type: 'STOP' },
          currentStatus as ThreadStatus,
        );
        await this.threadManager.updateThread(threadId, {
          status,
          completedAt: new Date().toISOString(),
        });
        await this.emitWS(threadId, 'agent:status', { status });
        await this.emitAgentCompleted(threadId, 'stopped');
      })();
    });

    // End run span on natural completion (emitted from message handler)
    threadEventBus.on('agent:completed', (event) => {
      if (this.runSpans.has(event.threadId)) {
        const status = event.status === 'completed' ? 'ok' : 'error';
        this.endRunSpan(
          event.threadId,
          status,
          event.status !== 'completed' ? event.status : undefined,
        );
      }
    });

    this.orchestrator.on('agent:session-cleared', (threadId: string) => {
      void (async () => {
        log.warn('Clearing stale sessionId after resume failure', { namespace: 'agent', threadId });
        await this.threadManager.updateThread(threadId, { sessionId: null });
      })();
    });

    // Adopt surviving agent processes from a previous --watch restart.
    // globalThis.__funnyActiveAgents is set by the previous cleanup handler.
    const surviving = (globalThis as any).__funnyActiveAgents as Map<string, any> | undefined;
    if (surviving?.size) {
      let adopted = 0;
      const markInterrupted: Promise<void>[] = [];
      for (const [threadId, proc] of surviving) {
        if (!proc.exited) {
          this.orchestrator.adoptProcess(threadId, proc);
          adopted++;
        } else {
          // Process exited during the transition — mark thread as interrupted
          // so it doesn't stay stuck in 'running' without an active process
          log.info('Surviving agent already exited, marking thread interrupted', {
            namespace: 'agent',
            threadId,
          });
          markInterrupted.push(
            (async () => {
              const t = await this.threadManager.getThread(threadId);
              if (t && (t.status === 'running' || t.status === 'waiting')) {
                await this.threadManager.updateThread(threadId, {
                  status: 'interrupted',
                  completedAt: new Date().toISOString(),
                });
              }
            })(),
          );
        }
      }
      if (markInterrupted.length > 0) {
        Promise.allSettled(markInterrupted).catch(() => {});
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

  private endRunSpan(threadId: string, status: 'ok' | 'error', errorMsg?: string): void {
    const span = this.runSpans.get(threadId);
    if (span) {
      span.end(status, errorMsg);
      this.runSpans.delete(threadId);
    }
    clearThreadTrace(threadId);
    metric('agents.running', this.runSpans.size, { type: 'gauge' });
  }

  private async emitWS(threadId: string, type: WSEvent['type'], data: unknown): Promise<void> {
    const event = { type, threadId, data } as WSEvent;
    const thread = await this.threadManager.getThread(threadId);
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
  private async emitAgentCompleted(
    threadId: string,
    status: 'completed' | 'failed' | 'stopped',
  ): Promise<void> {
    const thread = await this.threadManager.getThread(threadId);
    if (!thread) return;
    const project = thread.projectId
      ? await getServices().projects.getProject(thread.projectId)
      : undefined;
    threadEventBus.emit('agent:completed', {
      threadId,
      projectId: thread.projectId,
      userId: thread.userId,
      cwd: thread.worktreePath ?? project?.path ?? '',
      worktreePath: thread.worktreePath ?? null,
      status,
      cost: thread.cost ?? 0,
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
      promptFull: prompt,
    });

    // Clear stale DB-mapping state from previous runs
    this.state.clearRunState(threadId);

    // Transition the thread status via the state machine.
    // The machine picks the right event based on the current state, giving us
    // a `resumeReason` that tells us WHY we're entering `running` — so we can
    // choose the correct system prefix for the Claude session resume.
    const currentThread = await this.threadManager.getThread(threadId);

    // Pre-cache userId so emitWS doesn't hit the DB on every streaming event
    if (currentThread?.userId) {
      this.state.threadUserIds.set(threadId, currentThread.userId);
    }
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

    // Update thread status + provider in DB, reset completedAt when restarting
    await this.threadManager.updateThread(threadId, {
      status: newStatus,
      provider,
      completedAt: null,
    });

    // Save user message in DB (skip when a draft message already exists, e.g. idle threads)
    if (!skipMessageInsert) {
      await this.threadManager.insertMessage({
        threadId,
        role: 'user',
        content: prompt,
        images: images ? JSON.stringify(images) : null,
        model,
        permissionMode,
      });
    }

    // Read session ID from DB for resume
    const thread = await this.threadManager.getThread(threadId);

    // Check if this thread needs context recovery (post-merge, session exists but worktree gone)
    const needsRecovery = await needsContextRecovery(threadId);
    let effectivePrompt = prompt;
    let effectiveSessionId = thread?.sessionId ?? undefined;

    if (needsRecovery) {
      log.info('Thread needs context recovery (post-merge)', { namespace: 'agent', threadId });
      // Build conversation history from DB
      const context = await buildThreadContext(threadId);
      if (context) {
        // Prepend context to the user's new message
        effectivePrompt = `${context}\n\nUSER (new message):\n${prompt}`;
      }
      // Clear sessionId to force a fresh session with the full context
      await this.threadManager.updateThread(threadId, { sessionId: null });
      effectiveSessionId = undefined;
    }

    // Derive the system prefix from the machine's resumeReason
    const isPostMerge = !!(thread?.sessionId && thread?.baseBranch && !thread?.worktreePath);
    const resumePrefix = getResumeSystemPrefix(resumeReason, isPostMerge);

    // Inject project-level system prompt
    const project = thread?.projectId
      ? await getServices().projects.getProject(thread.projectId)
      : undefined;
    const projectSystemPrompt = project?.systemPrompt;

    // For fresh starts: prepend project system prompt to the user's message.
    // For resumes: combine with resume prefix (orchestrator prepends systemPrefix).
    if (projectSystemPrompt && !effectiveSessionId) {
      effectivePrompt = `[PROJECT INSTRUCTIONS]\n${projectSystemPrompt}\n[/PROJECT INSTRUCTIONS]\n\n${effectivePrompt}`;
    }

    // Paisley Park: recall project memory for context injection
    let memoryContext: string | undefined;
    if (project && !effectiveSessionId) {
      try {
        const pp = getPaisleyPark(project.id, project.name);
        const recallResult = await pp.recall(prompt, {
          limit: Number(process.env.MEMORY_RECALL_LIMIT) || 10,
          scope: 'all',
        });
        if (recallResult.isOk() && recallResult.value.formattedContext) {
          memoryContext = recallResult.value.formattedContext;
          log.debug('Memory context injected', {
            namespace: 'memory',
            threadId,
            factCount: recallResult.value.totalFound,
          });
        }
      } catch (e) {
        log.warn('Memory recall failed, proceeding without context', {
          namespace: 'memory',
          threadId,
          error: String(e),
        });
      }
    }

    const systemPrefix =
      [
        projectSystemPrompt
          ? `[PROJECT INSTRUCTIONS]\n${projectSystemPrompt}\n[/PROJECT INSTRUCTIONS]`
          : undefined,
        memoryContext,
        resumePrefix,
      ]
        .filter(Boolean)
        .join('\n\n') || undefined;

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
      await this.threadManager.updateThread(threadId, { permissionMode: 'autoEdit' });
    }

    await this.emitWS(threadId, 'agent:status', {
      status: 'running',
      ...(isPlanResume ? { permissionMode: 'autoEdit' as PermissionMode } : {}),
    });

    // Start a trace span for the entire agent run
    const runSpan = startSpan('agent.run', {
      attributes: { threadId, model, provider, permissionMode },
    });
    this.runSpans.set(threadId, runSpan);
    setThreadTrace(threadId, { traceId: runSpan.traceId, spanId: runSpan.spanId });
    metric('agents.running', this.runSpans.size, { type: 'gauge' });
    metric('threads.started', 1, { type: 'sum', attributes: { model, provider } });

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
      this.endRunSpan(threadId, 'error', err.message);
      log.error(`Failed to start ${provider} process`, {
        namespace: 'agent',
        threadId,
        error: err.message,
      });
      await this.threadManager.updateThread(threadId, {
        status: 'failed',
        completedAt: new Date().toISOString(),
      });
      await this.emitWS(threadId, 'agent:error', {
        error: err.message || `Failed to start ${provider} agent process`,
      });
      await this.emitWS(threadId, 'agent:status', { status: 'failed' });
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
    const thread = await this.threadManager.getThread(threadId);
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

import { createRemoteThreadManager } from './remote-thread-manager.js';

// Always use the remote thread manager that delegates persistence
// to the central server via WebSocket tunnel.
const threadManager: IThreadManager = createRemoteThreadManager();

const defaultRunner = new AgentRunner(threadManager, wsBroker, defaultProcessFactory);

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

setMemoryLogSink((level, namespace, message, data) => {
  const meta: Record<string, unknown> = { namespace: `memory:${namespace}`, ...data };
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
