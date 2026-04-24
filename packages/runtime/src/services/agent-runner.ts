/**
 * @domain subdomain: Agent Execution
 * @domain subdomain-type: core
 * @domain type: facade
 * @domain layer: application
 * @domain depends: AgentLifecycleManager, AgentEventRouter
 *
 * Thin facade that composes AgentLifecycleManager and AgentEventRouter.
 * Provides the backward-compatible singleton exports used throughout the runtime.
 */

import { setLogSink } from '@funny/core';
import { AgentOrchestrator, defaultProcessFactory } from '@funny/core/agents';
import type { IAgentProcessFactory } from '@funny/core/agents';
import type { AgentProvider, AgentModel, PermissionMode } from '@funny/shared';

import { log } from '../lib/logger.js';
import { AgentEventRouter } from './agent-event-router.js';
import { AgentLifecycleManager } from './agent-lifecycle.js';
import { AgentMessageHandler, type ProjectLookup } from './agent-message-handler.js';
import { AgentStateTracker } from './agent-state.js';
import type { IThreadManager, IWSBroker } from './server-interfaces.js';

// ── AgentRunner facade ────────────────────────────────────────

export class AgentRunner {
  private lifecycle: AgentLifecycleManager;
  private eventRouter: AgentEventRouter;

  constructor(
    threadManager: IThreadManager,
    wsBroker: IWSBroker,
    processFactory: IAgentProcessFactory,
    getProject?: ProjectLookup,
  ) {
    const orchestrator = new AgentOrchestrator(processFactory);
    const state = new AgentStateTracker();
    state.startAutoSweep();
    const messageHandler = new AgentMessageHandler(state, threadManager, wsBroker, getProject);

    this.eventRouter = new AgentEventRouter(
      orchestrator,
      state,
      messageHandler,
      threadManager,
      wsBroker,
    );

    this.lifecycle = new AgentLifecycleManager(
      orchestrator,
      threadManager,
      state,
      this.eventRouter,
    );

    // Wire up shared span context so event router can end spans on agent completion/failure
    this.eventRouter.setSpanContext(
      this.lifecycle.getRunSpans(),
      this.lifecycle.endRunSpan.bind(this.lifecycle),
    );
  }

  async startAgent(
    threadId: string,
    prompt: string,
    cwd: string,
    model?: AgentModel,
    permissionMode?: PermissionMode,
    images?: any[],
    disallowedTools?: string[],
    allowedTools?: string[],
    provider?: AgentProvider,
    mcpServers?: Record<string, any>,
    skipMessageInsert?: boolean,
    effort?: string,
  ): Promise<void> {
    return this.lifecycle.startAgent(
      threadId,
      prompt,
      cwd,
      model,
      permissionMode,
      images,
      disallowedTools,
      allowedTools,
      provider,
      mcpServers,
      skipMessageInsert,
      effort,
    );
  }

  async stopAgent(threadId: string): Promise<void> {
    return this.lifecycle.stopAgent(threadId);
  }

  isAgentRunning(threadId: string): boolean {
    return this.lifecycle.isAgentRunning(threadId);
  }

  cleanupThreadState(threadId: string): void {
    this.lifecycle.cleanupThreadState(threadId);
  }

  async stopAllAgents(): Promise<void> {
    return this.lifecycle.stopAllAgents();
  }

  extractActiveAgents(): Map<string, any> {
    return this.lifecycle.extractActiveAgents();
  }
}

// ── Default singleton (backward-compatible exports) ─────────────

import { createRemoteThreadManager } from './remote-thread-manager.js';
import { wsBroker } from './ws-broker.js';

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

// ── Self-register with ShutdownManager ──────────────────────
import { shutdownManager, ShutdownPhase } from './shutdown-manager.js';
shutdownManager.register(
  'agent-runner',
  async (mode) => {
    if (mode === 'hotReload') {
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
