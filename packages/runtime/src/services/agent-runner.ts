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
import {
  cleanupThreadState,
  extractActiveAgents,
  getSupportedSlashCommands,
  isAgentRunning,
  registerAgentRunnerControl,
  startAgent,
  stopAgent,
  stopAllAgents,
} from './agent-runner-control.js';
import { AgentStateTracker } from './agent-state.js';
import { IdleReaper } from './idle-reaper.js';
import type { IThreadManager, IWSBroker } from './server-interfaces.js';

// ── AgentRunner facade ────────────────────────────────────────

export class AgentRunner {
  private lifecycle: AgentLifecycleManager;
  private eventRouter: AgentEventRouter;
  private state: AgentStateTracker;
  private idleReaper?: IdleReaper;

  constructor(
    threadManager: IThreadManager,
    wsBroker: IWSBroker,
    processFactory: IAgentProcessFactory,
    getProject?: ProjectLookup,
    enableIdleReaper = false,
  ) {
    const orchestrator = new AgentOrchestrator(processFactory);
    const state = new AgentStateTracker();
    this.state = state;
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

    // The idle reaper runs only for the long-lived default runner, not for
    // ephemeral instances (tests). It drives the orchestrator's reap API.
    if (enableIdleReaper) {
      this.idleReaper = new IdleReaper(orchestrator);
      this.idleReaper.start();
    }
  }

  /** Stop the idle reaper ticker (hot reload / shutdown). No-op if disabled. */
  stopIdleReaper(): void {
    this.idleReaper?.stop();
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
    steer?: boolean,
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
      steer,
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

  /**
   * Slash commands the SDK reported for this thread (names without leading
   * slash), or `undefined` if none captured yet (no run this process lifetime).
   * `undefined` means "can't validate" — callers should allow through.
   */
  getSupportedSlashCommands(threadId: string): Set<string> | undefined {
    return this.state.supportedSlashCommands.get(threadId);
  }
}

// ── Default singleton (backward-compatible exports) ─────────────

import { createRemoteThreadManager } from './remote-thread-manager.js';
import { wsBroker } from './ws-broker.js';

const threadManager: IThreadManager = createRemoteThreadManager();
const defaultRunner = new AgentRunner(
  threadManager,
  wsBroker,
  defaultProcessFactory,
  undefined,
  true, // enable the idle reaper on the long-lived default runner
);

registerAgentRunnerControl({
  startAgent: defaultRunner.startAgent.bind(defaultRunner),
  stopAgent: defaultRunner.stopAgent.bind(defaultRunner),
  stopAllAgents: defaultRunner.stopAllAgents.bind(defaultRunner),
  isAgentRunning: defaultRunner.isAgentRunning.bind(defaultRunner),
  cleanupThreadState: defaultRunner.cleanupThreadState.bind(defaultRunner),
  extractActiveAgents: defaultRunner.extractActiveAgents.bind(defaultRunner),
  getSupportedSlashCommands: defaultRunner.getSupportedSlashCommands.bind(defaultRunner),
});

export {
  startAgent,
  stopAgent,
  stopAllAgents,
  isAgentRunning,
  cleanupThreadState,
  extractActiveAgents,
  getSupportedSlashCommands,
};

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
    // Stop the sweep ticker so a reload doesn't leave a second one running
    // (start() also dedupes via a global handle as a backstop).
    defaultRunner.stopIdleReaper();
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
