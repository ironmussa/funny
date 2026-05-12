/**
 * @domain subdomain: Pipeline
 * @domain subdomain-type: core
 * @domain type: adapter
 * @domain layer: infrastructure
 * @domain depends: ThreadService, GitService, AgentRunner, WSBroker, ThreadEventBus
 *
 * Bridges @funny/pipelines ActionProvider and ProgressReporter interfaces
 * with the Funny runtime services.
 *
 * This adapter allows the decoupled pipeline package to execute actions
 * (spawn agents, run git commands, send notifications) using the runtime's
 * existing infrastructure without importing it directly.
 */

import { gitRead, runHookCommand, invalidateStatusCache } from '@funny/core/git';
import type { ProgressReporter, StepProgressData } from '@funny/pipelines';
import type { AgentModel, PermissionMode, WSEvent } from '@funny/shared';
import { nanoid } from 'nanoid';

import { log } from '../lib/logger.js';
import { ApprovalTimeoutError } from '../pipelines/approval.js';
import type {
  ActionProvider,
  ActionResult,
  ApprovalDecision,
  SpawnAgentOpts,
  GitCommitOpts,
  GitPushOpts,
  CreatePrOpts,
  RunCommandOpts,
  NotifyOpts,
  RequestApprovalOpts,
  SetStatusOpts,
  SetStageOpts,
} from '../pipelines/types.js';
import {
  commitChanges as gitServiceCommit,
  pushChanges as gitServicePush,
  createPullRequest as gitServiceCreatePR,
  resolveIdentity,
} from './git-service.js';
import { pipelineApprovalStore } from './pipeline-approval-store.js';
import { threadEventBus } from './thread-event-bus.js';
import * as tm from './thread-manager.js';
import {
  createAndStartThread,
  emitThreadUpdated,
  updateThread as updateThreadService,
} from './thread-service.js';
import { emitWorkflowEvent } from './workflow-event-helpers.js';
import { wsBroker } from './ws-broker.js';

// Canonical lifecycle enums — kept in sync with @funny/shared/primitives.
// Duplicated here as plain arrays so we can validate at the action seam
// without importing runtime values from a types-only package.
const THREAD_STATUS_VALUES = [
  'setting_up',
  'idle',
  'pending',
  'running',
  'waiting',
  'completed',
  'failed',
  'stopped',
  'interrupted',
] as const;
type ThreadStatusValue = (typeof THREAD_STATUS_VALUES)[number];

const THREAD_STAGE_VALUES = [
  'backlog',
  'planning',
  'in_progress',
  'review',
  'done',
  'archived',
] as const;
type ThreadStageValue = (typeof THREAD_STAGE_VALUES)[number];

function isThreadStatus(v: string): v is ThreadStatusValue {
  return (THREAD_STATUS_VALUES as readonly string[]).includes(v);
}
function isThreadStage(v: string): v is ThreadStageValue {
  return (THREAD_STAGE_VALUES as readonly string[]).includes(v);
}

// ── RuntimeActionProvider ────────────────────────────────────

export interface RuntimeActionProviderOpts {
  /** Thread ID (for thread-scoped operations). */
  threadId?: string;
  /** Project ID. */
  projectId: string;
  /** User ID. */
  userId: string;
  /** Workflow ID (to mark pipeline commits). */
  workflowId?: string;
}

/**
 * ActionProvider implementation backed by Funny runtime services.
 *
 * - spawnAgent  → creates a child thread and waits for completion
 * - gitCommit   → calls git-service or @funny/core/git directly
 * - gitPush     → calls git-service or @funny/core/git directly
 * - createPr    → calls git-service
 * - runCommand  → executes via Bun.spawn
 * - notify      → emits workflow event to the thread
 */
export class RuntimeActionProvider implements ActionProvider {
  constructor(private opts: RuntimeActionProviderOpts) {}

  async spawnAgent(agentOpts: SpawnAgentOpts): Promise<ActionResult> {
    const { threadId, projectId, userId } = this.opts;

    if (!projectId) {
      return { ok: false, error: 'spawnAgent requires projectId' };
    }

    try {
      const prompt = agentOpts.context
        ? `${agentOpts.prompt}\n\nContext from previous step:\n${agentOpts.context}`
        : agentOpts.prompt;

      // Resolve model and permission mode: explicit opts > agent definition > defaults
      const effectiveMode = agentOpts.mode ?? agentOpts.agent?.permissionMode ?? 'autoEdit';
      const permissionMode: PermissionMode =
        effectiveMode === 'plan' ? 'plan' : effectiveMode === 'autoEdit' ? 'autoEdit' : 'autoEdit';

      // Resolve tool boundaries: explicit opts > agent definition > undefined.
      // Passing `undefined` lets `createAndStartThread` use its defaults; it
      // already merges user-level "always allow" rules into allowedTools.
      const allowedTools = agentOpts.allowedTools ?? agentOpts.agent?.allowedTools;
      const disallowedTools = agentOpts.disallowedTools ?? agentOpts.agent?.disallowedTools;

      const childThread = await createAndStartThread({
        projectId,
        userId,
        title: agentOpts.agent ? `Pipeline: ${agentOpts.agent.label}` : `Pipeline agent`,
        mode: 'local',
        provider: (agentOpts.agent?.provider ?? 'claude') as any,
        model: (agentOpts.model ?? agentOpts.agent?.model ?? 'sonnet') as AgentModel,
        permissionMode,
        source: 'automation',
        prompt,
        parentThreadId: threadId,
        allowedTools,
        disallowedTools,
      });

      log.info('Pipeline adapter: agent thread created', {
        namespace: 'pipeline-adapter',
        childThreadId: childThread.id,
      });

      // Wait for the agent to complete (polling)
      await waitForAgentCompletionPoll(childThread.id);

      // Get the last assistant message as output
      const threadWithMessages = await tm.getThreadWithMessages(childThread.id);
      const lastAssistantMsg = threadWithMessages?.messages
        ? [...threadWithMessages.messages].reverse().find((m) => m.role === 'assistant')
        : null;

      return {
        ok: true,
        output: lastAssistantMsg?.content ?? '',
        metadata: { threadId: childThread.id },
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async runCommand(opts: RunCommandOpts): Promise<ActionResult> {
    const hookResult = await runHookCommand(opts.cwd, opts.command);
    if (hookResult.isErr()) {
      return { ok: false, error: hookResult.error.message };
    }
    const { success, output } = hookResult.value;
    if (success) {
      return { ok: true, output: output || '' };
    }
    return { ok: false, error: output || 'Command failed', output };
  }

  async gitCommit(opts: GitCommitOpts): Promise<ActionResult> {
    const { threadId, userId, workflowId } = this.opts;

    // Mark as pipeline commit to prevent re-triggering review
    const patchListener = (event: { isPipelineCommit?: boolean }) => {
      event.isPipelineCommit = true;
    };
    threadEventBus.on('git:committed', patchListener as any);

    try {
      if (threadId) {
        const result = await gitServiceCommit(
          threadId,
          userId,
          opts.cwd,
          opts.message,
          opts.amend,
          opts.noVerify,
          workflowId,
        );
        if (result.isErr()) {
          const e = result.error;
          const errorMsg = e.type === 'PROCESS_ERROR' ? e.stderr || e.message : e.message;
          return { ok: false, error: errorMsg };
        }

        return {
          ok: true,
          output: result.value.output,
          metadata: { sha: result.value.sha },
        };
      }

      // No thread — direct git
      const { commit } = await import('@funny/core/git');
      const identity = await resolveIdentity(userId);
      const result = await commit(opts.cwd, opts.message, identity, opts.amend, opts.noVerify);
      if (result.isErr()) {
        const e = result.error;
        return {
          ok: false,
          error: e.type === 'PROCESS_ERROR' ? e.stderr || e.message : e.message,
        };
      }

      invalidateStatusCache(opts.cwd);

      const shaResult = await gitRead(['rev-parse', 'HEAD'], {
        cwd: opts.cwd,
        reject: false,
      });
      const sha = shaResult.exitCode === 0 ? shaResult.stdout.trim() : undefined;

      return { ok: true, output: result.value, metadata: { sha } };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      threadEventBus.removeListener('git:committed', patchListener as any);
    }
  }

  async gitPush(opts: GitPushOpts): Promise<ActionResult> {
    const { threadId, userId, workflowId } = this.opts;

    try {
      if (threadId) {
        const result = await gitServicePush(threadId, userId, opts.cwd, workflowId);
        if (result.isErr()) {
          const e = result.error;
          return {
            ok: false,
            error: e.type === 'PROCESS_ERROR' ? e.stderr || e.message : e.message,
          };
        }
        return { ok: true, output: result.value };
      }

      // No thread — direct git
      const { push } = await import('@funny/core/git');
      const identity = await resolveIdentity(userId);
      const result = await push(opts.cwd, identity);
      if (result.isErr()) {
        const e = result.error;
        return {
          ok: false,
          error: e.type === 'PROCESS_ERROR' ? e.stderr || e.message : e.message,
        };
      }

      invalidateStatusCache(opts.cwd);
      return { ok: true, output: result.value };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async createPr(opts: CreatePrOpts): Promise<ActionResult> {
    const { threadId, userId } = this.opts;

    if (!threadId) {
      return { ok: false, error: 'PR creation requires a thread' };
    }

    try {
      const result = await gitServiceCreatePR({
        threadId,
        userId,
        cwd: opts.cwd,
        title: opts.title,
        body: opts.body || '',
      });
      if (result.isErr()) {
        const e = result.error;
        return {
          ok: false,
          error: e.type === 'PROCESS_ERROR' ? e.stderr || e.message : e.message,
        };
      }
      return { ok: true, output: result.value };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async requestApproval(opts: RequestApprovalOpts): Promise<ApprovalDecision> {
    const { threadId, userId, workflowId } = this.opts;

    if (!threadId) {
      // Approval requires a thread to address the WS event to.
      throw new Error('requestApproval requires a threadId');
    }

    const approvalId = nanoid();
    const requestedAt = new Date().toISOString();
    const expiresAt = opts.timeoutMs
      ? new Date(Date.now() + opts.timeoutMs).toISOString()
      : undefined;

    log.info('Pipeline approval requested', {
      namespace: 'pipeline-adapter',
      approvalId,
      gateId: opts.gateId,
      threadId,
      timeoutMs: opts.timeoutMs,
    });

    // Emit BEFORE registering: keeps the UI honest about ordering — if the
    // emit fails, we never block on a gate that the client doesn't know
    // about. Risk: tiny race where the user clicks "approve" before the
    // promise is registered. We accept it because (a) WS round-trip is
    // slower than the next line of code and (b) the alternative (register
    // first, emit after) would silently swallow approvals if the emit
    // crashed. Future improvement: a small in-memory buffer of unmatched
    // responses keyed by approvalId.
    wsBroker.emitToUser(userId, {
      type: 'pipeline:approval_requested',
      threadId,
      data: {
        approvalId,
        gateId: opts.gateId,
        message: opts.message,
        captureResponse: opts.captureResponse ?? false,
        threadId,
        workflowId,
        requestedAt,
        expiresAt,
      },
    } as WSEvent);

    let payload;
    try {
      payload = await pipelineApprovalStore.register(
        approvalId,
        { threadId, userId, gateId: opts.gateId, requestedAt },
        opts.timeoutMs,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Emit a resolved event so the UI can clear the pending dialog.
      wsBroker.emitToUser(userId, {
        type: 'pipeline:approval_resolved',
        threadId,
        data: {
          approvalId,
          gateId: opts.gateId,
          threadId,
          decision: 'timeout',
          payload: message,
        },
      } as WSEvent);

      // Surface as ApprovalTimeoutError when the message matches; otherwise
      // re-throw the original error (cancellation, etc.).
      if (opts.timeoutMs && message.includes('timed out')) {
        throw new ApprovalTimeoutError(opts.gateId, opts.timeoutMs);
      }
      throw err;
    }

    // Notify clients that the approval is resolved (so any other tab
    // showing the dialog can dismiss it).
    wsBroker.emitToUser(userId, {
      type: 'pipeline:approval_resolved',
      threadId,
      data: {
        approvalId,
        gateId: opts.gateId,
        threadId,
        decision: payload.decision,
        payload: payload.text,
      },
    } as WSEvent);

    if (payload.decision === 'approve') {
      return { decision: 'approve', comment: payload.text };
    }
    return { decision: 'reject', reason: payload.text ?? 'rejected' };
  }

  async notify(opts: NotifyOpts): Promise<ActionResult> {
    const { threadId, userId, workflowId } = this.opts;

    if (threadId && workflowId) {
      try {
        await emitWorkflowEvent(userId, threadId, 'workflow:pipeline_message', {
          workflowId,
          message: opts.message,
          level: opts.level || 'info',
        });
      } catch {
        // Non-critical
      }
    }

    log.info(`Pipeline: ${opts.message}`, {
      namespace: 'pipeline-adapter',
      level: opts.level,
    });

    return { ok: true };
  }

  async setStatus(opts: SetStatusOpts): Promise<ActionResult> {
    const { userId } = this.opts;
    if (!isThreadStatus(opts.value)) {
      return {
        ok: false,
        error: `Invalid ThreadStatus "${opts.value}". Allowed: ${THREAD_STATUS_VALUES.join(', ')}`,
      };
    }
    try {
      const thread = await tm.getThread(opts.threadId);
      if (!thread) return { ok: false, error: `Thread ${opts.threadId} not found` };
      // Cross-tenant guard — never let a pipeline mutate another user's thread.
      if (thread.userId !== userId) {
        return { ok: false, error: 'set_status: thread belongs to a different user' };
      }
      await tm.updateThread(opts.threadId, { status: opts.value });
      emitThreadUpdated(userId, opts.threadId, { status: opts.value, reason: opts.reason });
      log.info('Pipeline set_status applied', {
        namespace: 'pipeline-adapter',
        threadId: opts.threadId,
        status: opts.value,
        reason: opts.reason,
      });
      return { ok: true, output: opts.value, metadata: { reason: opts.reason } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async setStage(opts: SetStageOpts): Promise<ActionResult> {
    const { userId } = this.opts;
    if (!isThreadStage(opts.value)) {
      return {
        ok: false,
        error: `Invalid ThreadStage "${opts.value}". Allowed: ${THREAD_STAGE_VALUES.join(', ')}`,
      };
    }
    try {
      // Delegate to thread-service so the canonical thread:stage-changed
      // event fires with fromStage/toStage and (where applicable) the
      // archive-cleanup side effects run.
      await updateThreadService({
        threadId: opts.threadId,
        userId,
        stage: opts.value,
      });
      log.info('Pipeline set_stage applied', {
        namespace: 'pipeline-adapter',
        threadId: opts.threadId,
        stage: opts.value,
        reason: opts.reason,
      });
      return { ok: true, output: opts.value, metadata: { reason: opts.reason } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

// ── RuntimeProgressReporter ──────────────────────────────────

export interface RuntimeProgressReporterOpts {
  userId: string;
  threadId: string;
  pipelineId?: string;
  runId?: string;
  workflowId?: string;
}

/**
 * ProgressReporter implementation that bridges to WS events and DB updates.
 *
 * Maps @funny/pipelines step progress and pipeline events to the runtime's
 * WebSocket broadcast and thread event persistence.
 */
export class RuntimeProgressReporter implements ProgressReporter {
  constructor(private opts: RuntimeProgressReporterOpts) {}

  onStepProgress(stepId: string, data: StepProgressData): void {
    const { userId, threadId, pipelineId, runId } = this.opts;

    if (pipelineId && runId) {
      wsBroker.emitToUser(userId, {
        type: 'pipeline:stage_update',
        threadId,
        data: {
          pipelineId,
          runId,
          threadId,
          stage: stepId,
          status: data.status,
          error: data.error,
          ...data.metadata,
        },
      } as WSEvent);
    }
  }

  onPipelineEvent(event: string, data: Record<string, unknown>): void {
    const { userId, threadId, pipelineId, runId, workflowId } = this.opts;

    if (threadId && workflowId) {
      void emitWorkflowEvent(userId, threadId, `workflow:${event}`, {
        workflowId,
        ...data,
      }).catch(() => {});
    }

    if (pipelineId && runId) {
      wsBroker.emitToUser(userId, {
        type: event === 'completed' ? 'pipeline:run_completed' : 'pipeline:stage_update',
        threadId,
        data: {
          pipelineId,
          runId,
          threadId,
          ...data,
        },
      } as WSEvent);
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────

/** Poll-based agent completion. */
async function waitForAgentCompletionPoll(threadId: string, timeoutMs = 300_000): Promise<void> {
  const { isAgentRunning } = await import('./agent-runner.js');
  const start = Date.now();
  const pollInterval = 1000;

  while (Date.now() - start < timeoutMs) {
    if (!isAgentRunning(threadId)) return;
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  throw new Error(`Agent timed out after ${timeoutMs}ms`);
}
