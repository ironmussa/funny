import { wsBroker } from './ws-broker.js';
import * as tm from './thread-manager.js';
import type { WSEvent, AgentProvider, AgentModel, PermissionMode } from '@funny/shared';
import { AgentOrchestrator, defaultProcessFactory } from '@funny/core/agents';
import type { IAgentProcessFactory } from '@funny/core/agents';
import type { IThreadManager, IWSBroker } from './server-interfaces.js';
import { AgentStateTracker } from './agent-state.js';
import { AgentMessageHandler, type ProjectLookup } from './agent-message-handler.js';
import { threadEventBus } from './thread-event-bus.js';

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
      this.threadManager.updateThread(threadId, { status: 'failed', completedAt: new Date().toISOString() });
      this.emitWS(threadId, 'agent:error', { error: err.message });
      this.emitWS(threadId, 'agent:status', { status: 'failed' });
    });

    this.orchestrator.on('agent:unexpected-exit', (threadId: string) => {
      this.threadManager.updateThread(threadId, { status: 'failed', completedAt: new Date().toISOString() });
      this.emitWS(threadId, 'agent:error', {
        error: 'Agent process exited unexpectedly without a result',
      });
      this.emitWS(threadId, 'agent:status', { status: 'failed' });
    });

    this.orchestrator.on('agent:stopped', (threadId: string) => {
      this.threadManager.updateThread(threadId, { status: 'stopped', completedAt: new Date().toISOString() });
      this.emitWS(threadId, 'agent:status', { status: 'stopped' });
    });

    this.orchestrator.on('agent:session-cleared', (threadId: string) => {
      console.warn(`[agent] Clearing stale sessionId for thread=${threadId} after resume failure`);
      this.threadManager.updateThread(threadId, { sessionId: null });
    });
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
  ): Promise<void> {
    // Clear stale DB-mapping state from previous runs
    this.state.clearRunState(threadId);

    // Update thread status + provider in DB
    this.threadManager.updateThread(threadId, { status: 'running', provider });

    // Auto-transition stage to 'in_progress' from 'backlog' or 'review'
    const currentThread = this.threadManager.getThread(threadId);
    if (currentThread && (currentThread.stage === 'review' || currentThread.stage === 'backlog')) {
      const fromStage = currentThread.stage;
      this.threadManager.updateThread(threadId, { stage: 'in_progress' });
      threadEventBus.emit('thread:stage-changed', {
        threadId, projectId: currentThread.projectId, userId: currentThread.userId,
        worktreePath: currentThread.worktreePath ?? null, cwd,
        fromStage, toStage: 'in_progress',
      });
    }

    // Save user message in DB
    this.threadManager.insertMessage({
      threadId,
      role: 'user',
      content: prompt,
      images: images ? JSON.stringify(images) : null,
      model,
      permissionMode,
    });

    // Read session ID from DB for resume
    const thread = this.threadManager.getThread(threadId);

    // When resuming a plan-mode thread, the orchestrator downgrades to autoEdit.
    // Sync the DB and notify the client so the PromptInput dropdown updates.
    const isPlanResume = thread?.sessionId && permissionMode === 'plan';
    if (isPlanResume) {
      this.threadManager.updateThread(threadId, { permissionMode: 'autoEdit' });
    }

    const updatedThread = this.threadManager.getThread(threadId);
    this.emitWS(threadId, 'agent:status', {
      status: 'running',
      stage: updatedThread?.stage,
      ...(isPlanResume ? { permissionMode: 'autoEdit' as PermissionMode } : {}),
    });

    // Delegate lifecycle to orchestrator
    try {
      await this.orchestrator.startAgent({
        threadId,
        prompt,
        cwd,
        model,
        permissionMode,
        images,
        disallowedTools,
        allowedTools,
        provider,
        sessionId: thread?.sessionId ?? undefined,
        mcpServers,
      });

      threadEventBus.emit('agent:started', {
        threadId, projectId: thread?.projectId ?? '', userId: thread?.userId ?? '',
        worktreePath: thread?.worktreePath ?? null, cwd,
        model, provider,
      });
    } catch (err: any) {
      console.error(`[agent] Failed to start ${provider} process for thread=${threadId}:`, err.message);
      this.threadManager.updateThread(threadId, {
        status: 'failed',
        completedAt: new Date().toISOString()
      });
      this.emitWS(threadId, 'agent:error', {
        error: err.message || `Failed to start ${provider} agent process`
      });
      this.emitWS(threadId, 'agent:status', { status: 'failed' });
      throw err;
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

}

// ── Default singleton (backward-compatible exports) ─────────────

const defaultRunner = new AgentRunner(
  tm,
  wsBroker,
  defaultProcessFactory,
);

export const startAgent = defaultRunner.startAgent.bind(defaultRunner);
export const stopAgent = defaultRunner.stopAgent.bind(defaultRunner);
export const stopAllAgents = defaultRunner.stopAllAgents.bind(defaultRunner);
export const isAgentRunning = defaultRunner.isAgentRunning.bind(defaultRunner);
export const cleanupThreadState = defaultRunner.cleanupThreadState.bind(defaultRunner);
