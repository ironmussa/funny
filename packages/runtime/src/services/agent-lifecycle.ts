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
import { reapOrphanedAgents, resolvePermissionApprovalCapability } from '@funny/core/agents';
import type {
  AgentProvider,
  AgentModel,
  PermissionMode,
  Thread,
  ThreadStatus,
} from '@funny/shared';
import { getResumeSystemPrefix } from '@funny/shared/thread-machine';
import type { ThreadEvent } from '@funny/shared/thread-machine';

import { log } from '../lib/logger.js';
import { clearThreadTrace, metric, setThreadTrace, startSpan } from '../lib/telemetry.js';
import { stripInlineReferencedContent } from '../utils/file-mentions.js';
import type { AgentEventRouter } from './agent-event-router.js';
import { buildAgentEnv } from './agent-startup/agent-env.js';
import {
  resolveActiveAgentProfile,
  type ActiveAgentProfile,
} from './agent-startup/agent-profile.js';
import { resolveAgentTooling } from './agent-startup/agent-tooling.js';
import { shouldForceColdPathRecovery } from './agent-startup/cold-path-guard.js';
import {
  buildBypassExecutor,
  buildPermissionRuleLookup,
} from './agent-startup/permission-hooks.js';
import { ensureLazyCwd, syncWorktreeProjectAssets } from './agent-startup/prepare-workspace.js';
import { recoverThreadContext } from './agent-startup/recover-context.js';
import { buildSystemPrefix, projectInstructionsBlock } from './agent-startup/system-prefix.js';
import type { AgentStateTracker } from './agent-state.js';
import { captureCodexCheckpoint } from './codex-git-checkpoints.js';
import type { IThreadManager, RuntimeThreadRecord } from './server-interfaces.js';
import { getServices } from './service-registry.js';
import { canDoGitOps, hasLazyCwd, resolveThreadCwd, tmpAssetsPathFor } from './thread-context.js';
import { threadEventBus } from './thread-event-bus.js';
import { transitionStatus } from './thread-status-machine.js';

type StartProject = Awaited<ReturnType<ReturnType<typeof getServices>['projects']['getProject']>>;

type ResumeReason = Parameters<typeof getResumeSystemPrefix>[0];

interface StartContext {
  thread: RuntimeThreadRecord | undefined;
  project: StartProject;
  effectivePrompt: string;
  effectiveSessionId: string | undefined;
  needsRecovery: boolean;
  isPostMerge: boolean;
  resumePrefix: string | undefined;
  projectSystemPrompt: string | undefined;
}

/** Project-level run flags forwarded to the orchestrator. */
function projectRunFlags(project: StartProject): { fastMode: boolean; steerable: boolean } {
  return {
    fastMode: project?.fastMode ?? false,
    steerable: project?.followUpMode === 'steer',
  };
}

function logResumeContext(info: {
  threadId: string;
  newStatus: ThreadStatus;
  resumeReason: ResumeReason | undefined;
  ctx: StartContext;
  systemPrefix: string | undefined;
}): void {
  const { ctx, systemPrefix } = info;
  log.info('startAgent resume context', {
    namespace: 'agent',
    threadId: info.threadId,
    newStatus: info.newStatus,
    resumeReason: info.resumeReason ?? 'none',
    isResume: !!ctx.effectiveSessionId,
    isPostMerge: ctx.isPostMerge,
    needsRecovery: ctx.needsRecovery,
    effectiveSessionId: ctx.effectiveSessionId ?? 'none',
    dbSessionId: ctx.thread?.sessionId ?? 'none',
    systemPrefixPreview: systemPrefix ? systemPrefix.slice(0, 80) : 'none',
  });
}

export class AgentLifecycleManager {
  private runSpans = new Map<string, ReturnType<typeof startSpan>>();

  constructor(
    private orchestrator: AgentOrchestrator,
    private threadManager: IThreadManager,
    private state: AgentStateTracker,
    private eventRouter: AgentEventRouter,
  ) {
    // Adopt agents preserved across an in-process hot-reload (globalThis snapshot)...
    this.adoptSurvivingProcesses();
    // ...then reap agents leaked by a FULL restart, where the snapshot was lost
    // and their processes orphaned. Adopted/live agents are owned by this (alive)
    // PID, so the reaper keeps them; only owner-dead orphans are killed.
    try {
      const reaped = reapOrphanedAgents((pids) =>
        log.warn(`Reaped ${pids.length} orphaned agent process(es) from a previous runtime`, {
          namespace: 'agent',
          pids,
        }),
      );
      if (reaped > 0) metric('agent.orphans_reaped', reaped);
    } catch (err) {
      log.warn('Orphaned-agent reaper failed', {
        namespace: 'agent',
        error: err instanceof Error ? err.message : String(err),
      });
    }
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

  /** Forward one structured provider permission decision to the current live
   * process. A false response is intentionally a stale/mismatched request. */
  async respondToPermission(
    threadId: string,
    requestId: string,
    decision: import('@funny/core/agents').PermissionDecision,
  ): Promise<boolean> {
    return this.orchestrator.respondToPermission(threadId, requestId, decision);
  }

  getPendingPermission(
    threadId: string,
    requestId: string,
  ): { toolName: string; toolInput?: string } | undefined {
    return this.orchestrator.getPendingPermission(threadId, requestId);
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
    /** Steer the live turn (interrupt + redirect) instead of respawning.
     *  Set by the caller when sending to a running thread in 'steer' mode. */
    steer?: boolean,
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

    const { currentThread, newStatus, resumeReason } = await this.transitionToRunning(
      threadId,
      provider,
    );
    const ownerId = currentThread?.userId;

    // Save user message in DB (skip when a draft message already exists).
    // The `prompt` we receive here is the agent-ready prompt (with file/symbol
    // contents inlined when references were used). Persist a path-only version
    // so the UI renders chips instead of dumping the full source files.
    if (!skipMessageInsert) {
      await this.threadManager.insertMessage({
        threadId,
        role: 'user',
        content: stripInlineReferencedContent(prompt),
        images: images ? JSON.stringify(images) : null,
        model,
        permissionMode,
        effort,
      });
    }

    await this.guardColdPathSession(threadId, currentThread, provider);

    const ctx = await this.loadStartContext(threadId, prompt, resumeReason);
    const { thread, project } = ctx;

    // Centralized cwd resolution — covers scratch / worktree / normal threads.
    // The caller passes a best-effort cwd, but `resolveThreadCwd` is the source
    // of truth (see scratch-threads design D3).
    if (thread) {
      const resolvedCwd = await this.resolveCwdOrFail(threadId, thread, project);
      if (resolvedCwd === null) return;
      cwd = resolvedCwd;
      await this.prepareWorkspace(threadId, thread, project, cwd, provider);
    }

    const activeAgentProfile = await resolveActiveAgentProfile(thread, provider);
    const tooling = await resolveAgentTooling({
      threadId,
      thread,
      projectPath: project?.path,
      provider,
      mcpServers,
      disallowedTools,
      claudeConfigDir: activeAgentProfile.env.CLAUDE_CONFIG_DIR,
    });

    // Per-user browser-previewable assets dir. Computed here so we can tell the
    // agent about it in the system prefix; the directory itself is created
    // (0700) and exported as FUNNY_ASSETS_DIR by buildAgentEnv below.
    const userId = thread?.userId;
    const assetsDir = userId ? tmpAssetsPathFor(userId) : undefined;

    const systemPrefix = buildSystemPrefix({
      // For Deep Agent templates, add template prompt before project prompt
      templateSystemPrompt: thread?.agentTemplateId ? tooling.systemPrompt : undefined,
      projectSystemPrompt: ctx.projectSystemPrompt,
      assetsDir,
      resumePrefix: ctx.resumePrefix,
    });

    logResumeContext({ threadId, newStatus, resumeReason, ctx, systemPrefix });

    this.emitRunningStatus(threadId, ownerId, provider);
    this.beginRunSpan(threadId, model, provider, permissionMode);

    // Resolve per-user API keys and git identity for agent subprocesses.
    const baseEnv = await buildAgentEnv({ threadId, userId, provider, assetsDir });
    const agentEnv = await this.applyAgentProfile(threadId, activeAgentProfile, baseEnv);

    await this.launchAgent(
      {
        threadId,
        prompt: ctx.effectivePrompt,
        cwd,
        model,
        permissionMode,
        images,
        disallowedTools: tooling.disallowedTools,
        allowedTools,
        provider,
        sessionId: ctx.effectiveSessionId,
        systemPrefix,
        mcpServers: tooling.mcpServers,
        env: agentEnv,
        effort,
        ...projectRunFlags(project),
        steer: !!steer,
        builtinSkillsDisabled: tooling.builtinSkillsDisabled,
        customSkillPaths: tooling.customSkillPaths,
        agentName: tooling.agentName,
        permissionRuleLookup: buildPermissionRuleLookup(
          threadId,
          userId,
          thread?.worktreePath ?? cwd,
        ),
        bypassExecutor: buildBypassExecutor(cwd),
      },
      thread,
      ownerId,
    );
  }

  // ── Start phases ───────────────────────────────────────────────

  /**
   * Re-read the thread (for the session ID to resume), recover context and
   * inject the project-level system prompt.
   */
  private async loadStartContext(
    threadId: string,
    prompt: string,
    resumeReason: ResumeReason,
  ): Promise<StartContext> {
    // Read session ID from DB for resume
    const thread = await this.threadManager.getThread(threadId);

    // Context recovery (post-merge or model/provider change)
    const recovered = await recoverThreadContext({
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

    let effectivePrompt = recovered.effectivePrompt;
    if (projectSystemPrompt && !recovered.effectiveSessionId) {
      effectivePrompt = `${projectInstructionsBlock(projectSystemPrompt)}\n\n${effectivePrompt}`;
    }

    return {
      thread,
      project,
      effectivePrompt,
      effectiveSessionId: recovered.effectiveSessionId,
      needsRecovery: recovered.needsRecovery,
      isPostMerge,
      resumePrefix,
      projectSystemPrompt,
    };
  }

  /** Drive the thread status machine to its running state and persist it. */
  private async transitionToRunning(threadId: string, provider: AgentProvider) {
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

    return { currentThread, newStatus, resumeReason };
  }

  /**
   * Cold-path session protection: if the thread has a persisted sessionId
   * but the agent process for it is gone (server restart, crash, manual
   * stop, watcher reload), force context recovery instead of letting ACP
   * providers attempt `session/load`. Those providers can stream conversation
   * history back as fire-and-forget notifications that race with the
   * loadSession response promise; the late notifications
   * get translated as new session updates and duplicate every prior
   * assistant message and tool call in the DB. Rebuilding the prompt from
   * DB-side context (via `recoverThreadContext`) gives the agent
   * equivalent continuity without triggering the replay race.
   *
   * The Claude and Pi SDK integrations resume without that race, so they are
   * exempted — forcing recovery there invalidates the prompt cache on
   * every follow-up and regenerates ~25k tokens of cache_creation per turn.
   */
  private async guardColdPathSession(
    threadId: string,
    currentThread: RuntimeThreadRecord | undefined,
    provider: AgentProvider,
  ): Promise<void> {
    const forceRecovery = shouldForceColdPathRecovery({
      thread: currentThread,
      isRunning: this.orchestrator.isRunning(threadId),
      provider,
    });
    if (!forceRecovery) return;

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

  /** Mark the thread failed and notify its owner. */
  private async failStart(
    threadId: string,
    userId: string | undefined,
    error: string,
  ): Promise<void> {
    await this.threadManager.updateThread(threadId, {
      status: 'failed',
      completedAt: new Date().toISOString(),
    });
    this.eventRouter.emitWSToUser(threadId, userId, 'agent:error', { error });
    this.eventRouter.emitWSToUser(threadId, userId, 'agent:status', { status: 'failed' });
  }

  /** Resolve the thread cwd; on failure marks the thread failed and returns null. */
  private async resolveCwdOrFail(
    threadId: string,
    thread: RuntimeThreadRecord,
    project: StartProject,
  ): Promise<string | null> {
    const cwdResult = resolveThreadCwd(
      thread as unknown as Thread,
      project ? { path: project.path } : null,
    );
    if (cwdResult.isOk()) return cwdResult.value;

    const errInfo = cwdResult.error;
    log.error('Failed to resolve thread cwd', {
      namespace: 'scratch-threads',
      threadId,
      kind: errInfo.kind,
      message: errInfo.message,
    });
    await this.failStart(threadId, thread.userId, errInfo.message);
    return null;
  }

  /** Get the working directory ready before the agent touches it. */
  private async prepareWorkspace(
    threadId: string,
    thread: RuntimeThreadRecord,
    project: StartProject,
    cwd: string,
    provider: AgentProvider,
  ): Promise<void> {
    const variant = thread as unknown as Thread;
    if (thread.mode === 'worktree' && project?.path && cwd !== project.path) {
      syncWorktreeProjectAssets(threadId, project.path, cwd);
    }

    // Ensure the scratch directory exists on disk before the agent starts.
    if (hasLazyCwd(variant)) {
      ensureLazyCwd(threadId, thread.userId, cwd);
    }

    // Codex has no native rewind API. Capture a Git snapshot for the latest
    // user message immediately before it can modify the worktree.
    if (provider === 'codex' && canDoGitOps(variant)) {
      await this.captureCodexRewindCheckpoint(threadId, cwd);
    }
  }

  /** A failed capture must not block the agent; it simply keeps rewind disabled. */
  private async captureCodexRewindCheckpoint(threadId: string, cwd: string): Promise<void> {
    try {
      const detail = await this.threadManager.getThreadWithMessages(threadId);
      const latestUserMessage = detail?.messages
        ?.slice()
        .reverse()
        .find((message: any) => message.role === 'user');
      if (!latestUserMessage?.id) {
        throw new Error('No user message is available for checkpointing');
      }
      await captureCodexCheckpoint({ threadId, messageId: latestUserMessage.id, cwd });
      await this.threadManager.updateThread(threadId, { fileCheckpointingEnabled: 1 });
    } catch (err) {
      await this.threadManager.updateThread(threadId, { fileCheckpointingEnabled: 0 });
      log.warn('Failed to capture Codex Git checkpoint; rewind remains disabled', {
        namespace: 'agent',
        threadId,
        cwd,
        error: (err as Error).message,
      });
    }
  }

  private emitRunningStatus(
    threadId: string,
    userId: string | undefined,
    provider: AgentProvider,
  ): void {
    const permissionApprovalCapability = resolvePermissionApprovalCapability(provider);
    this.eventRouter.emitWSToUser(threadId, userId, 'agent:status', {
      status: 'running',
      ...(permissionApprovalCapability ? { permissionApprovalCapability } : {}),
    });
  }

  /** Start a trace span for the entire agent run. */
  private beginRunSpan(
    threadId: string,
    model: AgentModel,
    provider: AgentProvider,
    permissionMode: PermissionMode,
  ): void {
    const runSpan = startSpan('agent.run', {
      attributes: { threadId, model, provider, permissionMode },
    });
    this.runSpans.set(threadId, runSpan);
    setThreadTrace(threadId, { traceId: runSpan.traceId, spanId: runSpan.spanId });
    metric('agents.running', this.runSpans.size, { type: 'gauge' });
    metric('threads.started', 1, { type: 'sum', attributes: { model, provider } });
  }

  /** Merge the active agent profile env and record (or clear) it on the thread. */
  private async applyAgentProfile(
    threadId: string,
    activeAgentProfile: ActiveAgentProfile,
    agentEnv: Record<string, string> | undefined,
  ): Promise<Record<string, string> | undefined> {
    const { profile } = activeAgentProfile;
    if (!profile) {
      await this.threadManager.updateThread(threadId, {
        agentProfileId: null,
        agentProfileName: null,
        agentProfileProvider: null,
      });
      return agentEnv;
    }
    await this.threadManager.updateThread(threadId, {
      agentProfileId: profile.id,
      agentProfileName: profile.name,
      agentProfileProvider: profile.provider,
    });
    return { ...(agentEnv ?? {}), ...activeAgentProfile.env };
  }

  /** Delegate the process lifecycle to the orchestrator. */
  private async launchAgent(
    options: Parameters<AgentOrchestrator['startAgent']>[0],
    thread: RuntimeThreadRecord | undefined,
    ownerId: string | undefined,
  ): Promise<void> {
    const { threadId, provider, cwd, model } = options;
    try {
      await this.orchestrator.startAgent(options);

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
      await this.failStart(
        threadId,
        ownerId,
        err.message || `Failed to start ${provider} agent process`,
      );
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

  extractActiveAgentSnapshot(): ReturnType<typeof this.orchestrator.extractActiveAgentSnapshot> {
    return this.orchestrator.extractActiveAgentSnapshot();
  }

  extractActiveAgents(): Map<string, any> {
    return this.extractActiveAgentSnapshot().agents;
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
    const snapshot = (globalThis as any).__funnyActiveAgentSnapshot as
      | ReturnType<typeof this.orchestrator.extractActiveAgentSnapshot>
      | undefined;
    const legacySurviving = (globalThis as any).__funnyActiveAgents as Map<string, any> | undefined;
    const surviving = snapshot?.agents ?? legacySurviving;
    if (!surviving?.size) return;

    let adopted = 0;
    const markInterrupted: Promise<void>[] = [];
    for (const [threadId, proc] of surviving) {
      if (!proc.exited) {
        this.orchestrator.adoptProcess(threadId, proc, {
          resultReceived: snapshot?.resultReceived.has(threadId),
          lastActivityAt: snapshot?.lastActivityAt.get(threadId),
          lastOptions: snapshot?.lastOptions.get(threadId),
        });
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
    delete (globalThis as any).__funnyActiveAgentSnapshot;
    delete (globalThis as any).__funnyActiveAgents;
  }
}
