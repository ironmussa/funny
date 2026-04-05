/**
 * @domain subdomain: Agent Execution
 * @domain subdomain-type: core
 * @domain type: app-service
 * @domain layer: application
 * @domain emits: agent:started
 * @domain depends: AgentOrchestrator, ThreadManager, AgentStateTracker, ThreadEventBus
 *
 * Manages agent start/stop lifecycle, context recovery, prompt assembly,
 * memory injection, and process adoption across hot-reloads.
 */

import type { AgentOrchestrator } from '@funny/core/agents';
import type { AgentProvider, AgentModel, PermissionMode, ThreadStatus } from '@funny/shared';
import { getResumeSystemPrefix } from '@funny/shared/thread-machine';
import type { ThreadEvent } from '@funny/shared/thread-machine';

import { log } from '../lib/logger.js';
import { metric, startSpan, setThreadTrace, clearThreadTrace } from '../lib/telemetry.js';
import type { AgentEventRouter } from './agent-event-router.js';
import type { AgentStateTracker } from './agent-state.js';
import type { IThreadManager } from './server-interfaces.js';
import { getServices } from './service-registry.js';
import { buildThreadContext, needsContextRecovery } from './thread-context-builder.js';
import { threadEventBus } from './thread-event-bus.js';
import { transitionStatus } from './thread-status-machine.js';

export class AgentLifecycleManager {
  private runSpans = new Map<string, ReturnType<typeof startSpan>>();

  constructor(
    private orchestrator: AgentOrchestrator,
    private threadManager: IThreadManager,
    private state: AgentStateTracker,
    private eventRouter: AgentEventRouter,
  ) {
    this.adoptSurvivingProcesses();
  }

  /** Access the run spans map (shared with AgentEventRouter) */
  getRunSpans(): Map<string, ReturnType<typeof startSpan>> {
    return this.runSpans;
  }

  /** End a run span and clean up trace context */
  endRunSpan(threadId: string, status: 'ok' | 'error', errorMsg?: string): void {
    const span = this.runSpans.get(threadId);
    if (span) {
      span.end(status, errorMsg);
      this.runSpans.delete(threadId);
    }
    clearThreadTrace(threadId);
    metric('agents.running', this.runSpans.size, { type: 'gauge' });
  }

  // ── Start ──────────────────────────────────────────────────────

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
    effort?: string,
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

    // Transition the thread status via the state machine
    const currentThread = await this.threadManager.getThread(threadId);

    // Pre-cache userId so emitWSToUser doesn't hit the DB on every streaming event
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

    // Save user message in DB (skip when a draft message already exists)
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

    // Context recovery (post-merge or model/provider change)
    let effectivePrompt = prompt;
    let effectiveSessionId = thread?.sessionId ?? undefined;
    const needsRecovery = await needsContextRecovery(threadId);

    if (needsRecovery) {
      const recoveryReason = thread?.contextRecoveryReason ?? 'post-merge';
      log.info('Thread needs context recovery', {
        namespace: 'agent',
        threadId,
        isPostMerge: !!thread?.mergedAt,
        reason: recoveryReason,
      });
      const context = await buildThreadContext(threadId);
      if (context) {
        effectivePrompt = `${context}\n\nUSER (new message):\n${prompt}`;
      }
      await this.threadManager.updateThread(threadId, {
        sessionId: null,
        contextRecoveryReason: null,
      });
      effectiveSessionId = undefined;
    }

    // Derive system prefix from the machine's resumeReason
    const isPostMerge = !!thread?.mergedAt;
    const resumePrefix = getResumeSystemPrefix(resumeReason, isPostMerge);

    // Inject project-level system prompt
    const project = thread?.projectId
      ? await getServices().projects.getProject(thread.projectId)
      : undefined;
    const projectSystemPrompt = project?.systemPrompt;

    if (projectSystemPrompt && !effectiveSessionId) {
      effectivePrompt = `[PROJECT INSTRUCTIONS]\n${projectSystemPrompt}\n[/PROJECT INSTRUCTIONS]\n\n${effectivePrompt}`;
    }

    // Paisley Park: project memory integration
    let memoryContext: string | undefined;
    const memoryEnabled =
      project?.memoryEnabled ||
      process.env.MEMORY_ENABLED === 'true' ||
      process.env.MEMORY_ENABLED === '1';
    if (project && memoryEnabled) {
      const memDbUrl = process.env.MEMORY_DB_URL ?? `file:${project.id}-memory.db`;
      const memSyncUrl = process.env.MEMORY_SYNC_URL;
      const memAuthToken = process.env.MEMORY_AUTH_TOKEN;

      // 1. Inject initial memory context (read-only seed for system prompt)
      if (!effectiveSessionId) {
        try {
          const { getPaisleyPark } = await import('@funny/memory');
          const pp = getPaisleyPark({
            url: memDbUrl,
            syncUrl: memSyncUrl,
            authToken: memAuthToken,
            projectId: project.id,
            projectName: project.name,
          });
          const recallResult = await pp.recall(prompt, {
            limit: Number(process.env.MEMORY_RECALL_LIMIT) || 10,
            scope: 'all',
          });
          if (recallResult.formattedContext) {
            memoryContext = recallResult.formattedContext;
            log.debug('Memory context injected', {
              namespace: 'memory',
              threadId,
              factCount: recallResult.totalFound,
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

      // 2. Attach Paisley Park MCP server so the agent can read/write memory during execution
      try {
        const memoryPkgDir = require.resolve('@funny/memory').replace(/\/src\/index\.ts$/, '');
        const mcpServerPath = `${memoryPkgDir}/src/mcp/server.ts`;
        const ppMcpEnv: Record<string, string> = {
          PP_PROJECT_ID: project.id,
          PP_PROJECT_NAME: project.name,
          PP_DB_URL: memDbUrl,
        };
        if (memSyncUrl) ppMcpEnv.PP_SYNC_URL = memSyncUrl;
        if (memAuthToken) ppMcpEnv.PP_AUTH_TOKEN = memAuthToken;

        mcpServers = {
          ...mcpServers,
          'paisley-park': {
            type: 'stdio' as const,
            command: 'bun',
            args: [mcpServerPath],
            env: ppMcpEnv,
          },
        };
        log.info('Paisley Park MCP server attached', {
          namespace: 'memory',
          threadId,
          mcpServerPath,
        });
      } catch (e) {
        log.warn('Failed to attach Paisley Park MCP server', {
          namespace: 'memory',
          threadId,
          error: String(e),
        });
      }
    }

    // Arc/purpose skill injection
    const PURPOSE_SKILL_MAP: Record<string, string> = {
      explore: 'openspec-explore',
      plan: 'openspec-propose',
      implement: 'openspec-apply-change',
    };

    if (thread?.arcId && !effectiveSessionId) {
      const purpose = ((thread as any).purpose as string | undefined) ?? 'implement';
      const skillName = PURPOSE_SKILL_MAP[purpose];
      if (skillName) {
        effectivePrompt = `/${skillName} ${effectivePrompt}`;
        log.info('Arc skill injected into prompt', {
          namespace: 'agent',
          threadId,
          purpose,
          skillName,
        });
      }
    }

    // Build memory tools hint if MCP is attached
    const memoryHint = mcpServers?.['paisley-park']
      ? [
          '[MEMORY SYSTEM]',
          'You have access to project memory via Paisley Park MCP tools (pp_recall, pp_add, pp_invalidate, pp_search, pp_evolve).',
          '- Use pp_recall BEFORE starting work to check for relevant decisions, patterns, or known issues.',
          '- Use pp_add to store important non-obvious knowledge (decisions, bug root causes, conventions, insights).',
          '- Do NOT store information derivable from code, git history, or file structure.',
          '- Use pp_invalidate when you discover a stored fact is no longer accurate.',
          '[/MEMORY SYSTEM]',
        ].join('\n')
      : undefined;

    const systemPrefix =
      [
        projectSystemPrompt
          ? `[PROJECT INSTRUCTIONS]\n${projectSystemPrompt}\n[/PROJECT INSTRUCTIONS]`
          : undefined,
        memoryContext,
        memoryHint,
        resumePrefix,
      ]
        .filter(Boolean)
        .join('\n\n') || undefined;

    log.info('startAgent resume context', {
      namespace: 'agent',
      threadId,
      newStatus,
      resumeReason: resumeReason ?? 'none',
      isResume: !!effectiveSessionId,
      isPostMerge,
      needsRecovery,
      effectiveSessionId: effectiveSessionId ?? 'none',
      dbSessionId: thread?.sessionId ?? 'none',
      systemPrefixPreview: systemPrefix ? systemPrefix.slice(0, 80) : 'none',
    });

    this.eventRouter.emitWSToUser(threadId, currentThread?.userId, 'agent:status', {
      status: 'running',
    });

    // Start a trace span for the entire agent run
    const runSpan = startSpan('agent.run', {
      attributes: { threadId, model, provider, permissionMode },
    });
    this.runSpans.set(threadId, runSpan);
    setThreadTrace(threadId, { traceId: runSpan.traceId, spanId: runSpan.spanId });
    metric('agents.running', this.runSpans.size, { type: 'gauge' });
    metric('threads.started', 1, { type: 'sum', attributes: { model, provider } });

    // Resolve per-user API keys for providers that need them
    let agentEnv: Record<string, string> | undefined;
    if (thread?.userId) {
      const { PROVIDER_KEY_REGISTRY } = await import('@funny/shared/models');
      const relevantKeys = PROVIDER_KEY_REGISTRY.filter(
        (k) => k.envVar && k.requiredByProviders?.includes(provider),
      );
      for (const keyConfig of relevantKeys) {
        const keyValue = await getServices().profile.getProviderKey(thread.userId, keyConfig.id);
        if (keyValue && keyConfig.envVar) {
          agentEnv ??= {};
          agentEnv[keyConfig.envVar] = keyValue;
        }
      }
    }

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
        env: agentEnv,
        effort,
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
      this.eventRouter.emitWSToUser(threadId, currentThread?.userId, 'agent:error', {
        error: err.message || `Failed to start ${provider} agent process`,
      });
      this.eventRouter.emitWSToUser(threadId, currentThread?.userId, 'agent:status', {
        status: 'failed',
      });
      throw err;
    }
  }

  // ── Stop / Cleanup ─────────────────────────────────────────────

  async stopAgent(threadId: string): Promise<void> {
    const thread = await this.threadManager.getThread(threadId);
    if (thread?.provider === 'external') return;
    await this.orchestrator.stopAgent(threadId);
  }

  isAgentRunning(threadId: string): boolean {
    return this.orchestrator.isRunning(threadId);
  }

  cleanupThreadState(threadId: string): void {
    this.orchestrator.cleanupThread(threadId);
    this.state.cleanupThread(threadId);
    this.eventRouter.clearQueue(threadId);
  }

  async stopAllAgents(): Promise<void> {
    this.eventRouter.destroy();
    await this.orchestrator.stopAll();
  }

  extractActiveAgents(): Map<string, any> {
    return this.orchestrator.extractActiveAgents();
  }

  // ── Helpers ────────────────────────────────────────────────────

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
        return { type: 'START' };
      default:
        return { type: 'START' };
    }
  }

  /** Adopt surviving agent processes from a previous --watch restart */
  private adoptSurvivingProcesses(): void {
    const surviving = (globalThis as any).__funnyActiveAgents as Map<string, any> | undefined;
    if (!surviving?.size) return;

    let adopted = 0;
    const markInterrupted: Promise<void>[] = [];
    for (const [threadId, proc] of surviving) {
      if (!proc.exited) {
        this.orchestrator.adoptProcess(threadId, proc);
        adopted++;
      } else {
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
