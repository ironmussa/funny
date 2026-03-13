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

import { log } from '../lib/logger.js';
import type {
  ActionProvider,
  ActionResult,
  SpawnAgentOpts,
  GitCommitOpts,
  GitPushOpts,
  CreatePrOpts,
  RunCommandOpts,
  NotifyOpts,
} from '../pipelines/types.js';
import {
  commitChanges as gitServiceCommit,
  pushChanges as gitServicePush,
  createPullRequest as gitServiceCreatePR,
  resolveIdentity,
} from './git-service.js';
import { threadEventBus } from './thread-event-bus.js';
import * as tm from './thread-manager.js';
import { createAndStartThread } from './thread-service.js';
import { emitWorkflowEvent } from './workflow-event-helpers.js';
import { wsBroker } from './ws-broker.js';

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

      const permissionMode: PermissionMode =
        agentOpts.mode === 'plan'
          ? 'plan'
          : agentOpts.mode === 'autoEdit'
            ? 'autoEdit'
            : 'autoEdit';

      const childThread = await createAndStartThread({
        projectId,
        userId,
        title: `Pipeline agent`,
        mode: 'local',
        provider: 'claude',
        model: (agentOpts.model || 'sonnet') as AgentModel,
        permissionMode,
        source: 'automation',
        prompt,
        parentThreadId: threadId,
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
    try {
      const result = await runHookCommand(opts.cwd, opts.command);
      if (result.success) {
        return { ok: true, output: result.output || '' };
      }
      return { ok: false, error: result.output || 'Command failed', output: result.output };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
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

        // Get SHA
        const shaResult = await gitRead(['rev-parse', 'HEAD'], {
          cwd: opts.cwd,
          reject: false,
        });
        const sha = shaResult.exitCode === 0 ? shaResult.stdout.trim() : undefined;

        return { ok: true, output: result.value, metadata: { sha } };
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
