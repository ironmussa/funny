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
import { clearThreadTrace, metric, setThreadTrace, startSpan } from '../lib/telemetry.js';
import type { AgentEventRouter } from './agent-event-router.js';
import { shouldForceColdPathRecovery } from './agent-startup/cold-path-guard.js';
import { loadProjectMcpServers } from './agent-startup/load-mcp-servers.js';
import { recoverThreadContext } from './agent-startup/recover-context.js';
import type { AgentStateTracker } from './agent-state.js';
import type { IThreadManager } from './server-interfaces.js';
import { getServices } from './service-registry.js';
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

    // Cold-path session protection: if the thread has a persisted sessionId
    // but the agent process for it is gone (server restart, crash, manual
    // stop, watcher reload), force context recovery instead of letting the
    // next process attempt `session/load`. gemini-cli/codex/pi-coding-agent
    // all stream conversation history back as fire-and-forget notifications
    // that race with the loadSession response promise; the late notifications
    // get translated as new session updates and duplicate every prior
    // assistant message and tool call in the DB. Rebuilding the prompt from
    // DB-side context (via `recoverThreadContext` below) gives the agent
    // equivalent continuity without triggering the replay race.
    //
    // The Claude SDK resumes by sessionId without that race, so it is
    // exempted — forcing recovery there invalidates the prompt cache on
    // every follow-up and regenerates ~25k tokens of cache_creation per turn.
    if (
      shouldForceColdPathRecovery({
        thread: currentThread,
        isRunning: this.orchestrator.isRunning(threadId),
        provider,
      })
    ) {
      log.info('Cold-path session: forcing recovery to avoid loadSession replay race', {
        namespace: 'agent',
        threadId,
        sessionId: currentThread!.sessionId,
        provider,
      });
      await this.threadManager.updateThread(threadId, {
        contextRecoveryReason: 'process_lost',
      });
    }

    // Read session ID from DB for resume
    const thread = await this.threadManager.getThread(threadId);

    // Context recovery (post-merge or model/provider change)
    let { effectivePrompt, effectiveSessionId, needsRecovery } = await recoverThreadContext({
      threadId,
      prompt,
      thread,
      threadManager: this.threadManager,
    });

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

    // Load project MCP servers when none were explicitly provided.
    // Use the canonical project path (not the worktree cwd) so that
    // ~/.claude.json project settings and .mcp.json are found correctly.
    const mcpProjectPath = project?.path ?? cwd;
    if (!mcpServers) {
      mcpServers = await loadProjectMcpServers(threadId, mcpProjectPath);
    }

    // Resolve agent template (Deep Agent only)
    let templateSystemPrompt: string | undefined;
    let tplBuiltinSkillsDisabled: string[] | undefined;
    let tplCustomSkillPaths: string[] | undefined;
    let tplAgentName: string | undefined;
    if (thread?.agentTemplateId && provider === 'deepagent') {
      try {
        // Check builtin templates first (no remote call needed)
        const { BUILTIN_AGENT_TEMPLATES } = await import('@funny/shared');
        const builtinTpl = BUILTIN_AGENT_TEMPLATES.find(
          (t: { id: string }) => t.id === thread.agentTemplateId,
        );
        const { remoteGetAgentTemplate } = await import('./team-client.js');
        const tpl = builtinTpl ?? (await remoteGetAgentTemplate(thread.agentTemplateId));
        if (tpl) {
          // Helper to parse JSON text columns that may already be parsed
          const parseJsonCol = <T>(val: unknown): T[] =>
            val ? ((typeof val === 'string' ? JSON.parse(val) : val) as T[]) : [];

          const tplDisallowed = parseJsonCol<string>(tpl.disallowedTools);
          const tplMcpServers = parseJsonCol<any>(tpl.mcpServers);

          // Merge template disallowed tools
          if (tplDisallowed.length > 0) {
            disallowedTools = [...(disallowedTools ?? []), ...tplDisallowed];
          }

          // Merge template MCP servers (additive)
          if (tplMcpServers.length > 0) {
            mcpServers = { ...(mcpServers ?? {}) };
            for (const srv of tplMcpServers) {
              mcpServers[srv.name] = srv;
            }
          }

          // Template system prompt (mode: replace | prepend | append)
          if (tpl.systemPrompt) {
            templateSystemPrompt = tpl.systemPrompt;

            // Interpolate template variables: replace {{VAR_NAME}} with values
            const rawVars = thread.templateVariables;
            const varValues: Record<string, string> =
              typeof rawVars === 'string'
                ? JSON.parse(rawVars)
                : rawVars && typeof rawVars === 'object'
                  ? rawVars
                  : {};
            if (Object.keys(varValues).length > 0) {
              templateSystemPrompt = templateSystemPrompt.replace(
                /\{\{(\w+)\}\}/g,
                (match, name) => varValues[name] ?? match,
              );
            }
            // prepend/append are handled below in systemPrefix assembly
          }

          // Phase 2: Parse remaining template fields for runtime wiring
          tplBuiltinSkillsDisabled = parseJsonCol<string>(tpl.builtinSkillsDisabled);
          tplCustomSkillPaths = parseJsonCol<string>(tpl.customSkillPaths);
          tplAgentName = tpl.agentName ?? undefined;

          log.info('Agent template resolved', {
            namespace: 'agent',
            threadId,
            templateId: tpl.id,
            templateName: tpl.name,
            systemPromptMode: tpl.systemPromptMode,
            disallowedToolsCount: tplDisallowed.length,
            mcpServersCount: tplMcpServers.length,
            builtinSkillsDisabled: tplBuiltinSkillsDisabled,
            customSkillPaths: tplCustomSkillPaths?.length ?? 0,
            agentName: tplAgentName,
          });
        }
      } catch (err) {
        log.warn('Failed to resolve agent template', {
          namespace: 'agent',
          threadId,
          templateId: thread.agentTemplateId,
          error: (err as Error).message,
        });
      }
    }

    const systemPrefix =
      [
        // For Deep Agent templates with 'prepend' mode, add template prompt before project prompt
        templateSystemPrompt && thread?.agentTemplateId
          ? `[AGENT TEMPLATE]\n${templateSystemPrompt}\n[/AGENT TEMPLATE]`
          : undefined,
        projectSystemPrompt
          ? `[PROJECT INSTRUCTIONS]\n${projectSystemPrompt}\n[/PROJECT INSTRUCTIONS]`
          : undefined,
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

    // Build a permission rule lookup bound to this thread's user + project.
    // The hook in core uses it to short-circuit prompts on persisted
    // "always allow / always deny" decisions. Returns null on transport
    // failure so the hook falls through to the interactive prompt.
    const ruleLookupUserId = thread?.userId;
    const ruleLookupProjectPath = thread?.worktreePath ?? cwd;
    const permissionRuleLookup = ruleLookupUserId
      ? async (query: { toolName: string; toolInput?: string }) => {
          try {
            const { findPermissionRule } = await import('./permission-rules-client.js');
            const rule = await findPermissionRule({
              userId: ruleLookupUserId,
              projectPath: ruleLookupProjectPath,
              toolName: query.toolName,
              toolInput: query.toolInput,
            });
            if (!rule) return null;
            return { decision: rule.decision };
          } catch (err) {
            log.warn('permissionRuleLookup failed', {
              namespace: 'agent',
              threadId,
              toolName: query.toolName,
              error: (err as Error)?.message,
            });
            return null;
          }
        }
      : undefined;

    // Bypass executor for sensitive-path operations (e.g. ~/.claude/) when
    // the user has saved an "always allow" rule. Performs the file/bash
    // operation directly and returns the synthetic tool_result text the
    // hook surfaces — the SDK's hardcoded sensitive-path block ignores the
    // hook's allow decision, so we have to do the work ourselves.
    const bypassExecutor = async (query: {
      toolName: string;
      toolInput: unknown;
      cwd?: string;
    }) => {
      const { runSensitivePathBypass } = await import('./sensitive-path-bypass.js');
      return runSensitivePathBypass({ ...query, cwd: query.cwd ?? cwd });
    };

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
        builtinSkillsDisabled: tplBuiltinSkillsDisabled,
        customSkillPaths: tplCustomSkillPaths,
        agentName: tplAgentName,
        permissionRuleLookup,
        bypassExecutor,
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
