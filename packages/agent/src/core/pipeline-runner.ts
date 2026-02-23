/**
 * PipelineRunner — main orchestration for pipeline execution.
 *
 * Uses QualityPipeline to run multiple quality agents (tests, security, etc.)
 * in parallel via direct AgentExecutor calls. Each agent gets its own
 * model/provider and returns structured AgentResult objects.
 *
 * Publishes PipelineEvents on the EventBus for downstream consumers
 * (ManifestWriter, Director, Integrator, BranchCleaner, Adapters).
 */

import { execute } from '@funny/core/git';
import type {
  PipelineRequest,
  PipelineState,
  PipelineStatus,
  Tier,
  AgentName,
} from './types.js';
import { classifyTier, type TierThresholds } from './tier-classifier.js';
import { QualityPipeline } from './quality-pipeline.js';
import { StateMachine, PIPELINE_TRANSITIONS } from './state-machine.js';
import type { EventBus } from '../infrastructure/event-bus.js';
import type { CircuitBreakers } from '../infrastructure/circuit-breaker.js';
import type { RequestLogger } from '../infrastructure/request-logger.js';
import type { PipelineServiceConfig } from '../config/schema.js';
import { logger } from '../infrastructure/logger.js';
import { nanoid } from 'nanoid';

// ── PipelineRunner ──────────────────────────────────────────────

export class PipelineRunner {
  private states = new Map<string, PipelineState>();
  private machines = new Map<string, StateMachine<PipelineStatus>>();
  private activePipelines = new Map<string, QualityPipeline>();
  private abortControllers = new Map<string, AbortController>();
  /** Per-request message counters for unique CLI message IDs */
  private msgCounters = new Map<string, number>();

  constructor(
    private eventBus: EventBus,
    private config: PipelineServiceConfig,
    private circuitBreakers?: CircuitBreakers,
    private requestLogger?: RequestLogger,
  ) {}

  /**
   * Emit a pipeline.cli_message event with an assistant text message.
   * Used by PipelineRunner stages to send user-visible status updates.
   */
  private async emitCLIText(
    requestId: string,
    text: string,
    metadata?: Record<string, unknown>,
    author?: string,
  ): Promise<void> {
    const count = (this.msgCounters.get(requestId) ?? 0) + 1;
    this.msgCounters.set(requestId, count);

    await this.eventBus.publish({
      event_type: 'pipeline.cli_message',
      request_id: requestId,
      timestamp: new Date().toISOString(),
      data: {
        cli_message: {
          type: 'assistant',
          message: {
            id: `pipeline-msg-${count}`,
            content: [{ type: 'text', text }],
          },
          author: author ?? 'pipeline',
        },
        author: author ?? 'pipeline',
      },
      metadata,
    });
  }

  // ── Public API ──────────────────────────────────────────────────

  async run(request: PipelineRequest): Promise<void> {
    const { request_id } = request;
    const baseBranch = request.base_branch ?? this.config.branch.main;
    const pipelinePrefix = this.config.branch.pipeline_prefix;

    // Initialize state + FSM
    const machine = new StateMachine(PIPELINE_TRANSITIONS, 'accepted' as PipelineStatus, `pipeline:${request_id}`);
    this.machines.set(request_id, machine);
    this.states.set(request_id, {
      request_id,
      status: 'accepted',
      tier: null,
      pipeline_branch: `${pipelinePrefix}${request.branch}`,
      started_at: new Date().toISOString(),
      request,
      events_count: 0,
      corrections_count: 0,
      corrections_applied: [],
    });

    // Create abort controller for this run
    const abortController = new AbortController();
    this.abortControllers.set(request_id, abortController);

    // Publish accepted event (metadata carries projectId for thread creation)
    await this.eventBus.publish({
      event_type: 'pipeline.accepted',
      request_id,
      timestamp: new Date().toISOString(),
      data: { branch: request.branch, worktree_path: request.worktree_path, projectId: request.projectId },
      metadata: request.metadata,
    });
    this.requestLogger?.info('pipeline.runner', request_id, 'accepted', `Pipeline accepted for branch ${request.branch}`, { branch: request.branch, worktree_path: request.worktree_path });

    // Emit system/init so the thread transitions to "running" state
    await this.eventBus.publish({
      event_type: 'pipeline.cli_message',
      request_id,
      timestamp: new Date().toISOString(),
      data: {
        cli_message: {
          type: 'system',
          subtype: 'init',
          session_id: `pipeline-${request_id}`,
          tools: [],
          model: 'pipeline',
          cwd: request.worktree_path,
        },
      },
      metadata: request.metadata,
    });

    // Emit user-visible accepted message
    await this.emitCLIText(request_id, `Received pipeline request for branch \`${request.branch}\`\nAnalyzing changeset...`, request.metadata);

    try {
      // 1. Classify tier using config thresholds
      const thresholds: TierThresholds = {
        small: { max_files: this.config.tiers.small.max_files, max_lines: this.config.tiers.small.max_lines },
        medium: { max_files: this.config.tiers.medium.max_files, max_lines: this.config.tiers.medium.max_lines },
      };
      const { tier, stats } = await classifyTier(
        request.worktree_path,
        baseBranch,
        thresholds,
        request.config?.tier,
      );

      this.transitionStatus(request_id, 'running');
      this.updateState(request_id, { tier });

      await this.eventBus.publish({
        event_type: 'pipeline.tier_classified',
        request_id,
        timestamp: new Date().toISOString(),
        data: { tier, stats },
        metadata: request.metadata,
      });

      logger.info({ requestId: request_id, tier, stats }, 'Tier classified');
      this.requestLogger?.info('pipeline.runner', request_id, 'tier_classified', `Classified as ${tier}`, { tier, stats });

      // Emit user-visible tier classification message
      await this.emitCLIText(
        request_id,
        `Changeset classified as **${tier}** tier — ${stats.filesChanged} files changed (+${stats.insertions}/-${stats.deletions} lines)`,
        request.metadata,
      );

      // 2. Determine agents from tier config
      const tierAgents: Record<Tier, AgentName[]> = {
        small: this.config.tiers.small.agents as AgentName[],
        medium: this.config.tiers.medium.agents as AgentName[],
        large: this.config.tiers.large.agents as AgentName[],
      };
      const agents = request.config?.agents ?? tierAgents[tier];

      // 3. Get diff stats for AgentContext
      const changedFiles = await this.getChangedFiles(request.worktree_path, baseBranch);
      const diffStats = {
        files_changed: stats.filesChanged,
        lines_added: stats.insertions,
        lines_deleted: stats.deletions,
        changed_files: changedFiles,
      };

      // 4. Publish pipeline.started
      await this.eventBus.publish({
        event_type: 'pipeline.started',
        request_id,
        timestamp: new Date().toISOString(),
        data: { tier, agents, model_count: agents.length },
        metadata: request.metadata,
      });

      // Emit user-visible dispatch message
      await this.emitCLIText(
        request_id,
        `Dispatching **${agents.length}** quality agents: ${agents.map(a => `\`${a}\``).join(', ')}\nEach agent will analyze the changeset independently...`,
        request.metadata,
      );

      // 5. Create and run QualityPipeline
      const pipeline = new QualityPipeline(this.eventBus, this.config, abortController.signal);
      this.activePipelines.set(request_id, pipeline);

      const runPipeline = async () => {
        const result = await pipeline.run(request_id, request, tier, agents, diffStats);

        // Update state with correction info
        this.updateState(request_id, {
          corrections_count: result.correctionsApplied.length,
          corrections_applied: result.correctionsApplied,
        });

        // 6. Determine overall outcome and emit terminal event
        const state = this.states.get(request_id)!;
        const terminalEvent = result.overallStatus === 'failed' ? 'pipeline.failed' : 'pipeline.completed';

        await this.eventBus.publish({
          event_type: terminalEvent,
          request_id,
          timestamp: new Date().toISOString(),
          data: {
            result: JSON.stringify(result.agentResults),
            branch: request.branch,
            pipeline_branch: state.pipeline_branch,
            worktree_path: request.worktree_path,
            base_branch: baseBranch,
            tier,
            corrections_applied: result.correctionsApplied,
            num_agents: result.agentResults.length,
            skip_merge: request.config?.skip_merge ?? false,
          },
          metadata: request.metadata,
        });

        // Emit user-visible completion summary
        const passed = result.agentResults.filter((r: any) => r.status === 'passed').length;
        const failed = result.agentResults.filter((r: any) => r.status === 'failed').length;
        const statusLabel = result.overallStatus === 'failed' ? 'Failed' : 'Passed';
        const agentSummaries = result.agentResults.map((r: any) =>
          `- \`${r.agent}\`: **${r.status}** (${r.findings?.length ?? 0} findings, ${r.fixes_applied ?? 0} fixes)`
        ).join('\n');
        await this.emitCLIText(
          request_id,
          `Pipeline **${statusLabel}** — ${passed} passed, ${failed} failed, ${result.correctionsApplied.length} corrections\n\n${agentSummaries}`,
          request.metadata,
        );

        this.updateStatus(request_id, result.overallStatus === 'failed' ? 'failed' : 'approved');
      };

      // Wrap in circuit breaker if available
      if (this.circuitBreakers) {
        await this.circuitBreakers.claude.execute(runPipeline);
      } else {
        await runPipeline();
      }
    } catch (err: any) {
      if (abortController.signal.aborted) {
        // Stopped by user
        this.updateStatus(request_id, 'failed');
        await this.eventBus.publish({
          event_type: 'pipeline.stopped',
          request_id,
          timestamp: new Date().toISOString(),
          data: {},
          metadata: request.metadata,
        });
        return;
      }

      logger.error({ requestId: request_id, err: err.message }, 'Pipeline execution failed');
      this.requestLogger?.error('pipeline.runner', request_id, 'execution_failed', err.message, { error: err.message });
      this.updateStatus(request_id, 'error');
      await this.eventBus.publish({
        event_type: 'pipeline.failed',
        request_id,
        timestamp: new Date().toISOString(),
        data: { error: err.message },
        metadata: request.metadata,
      });
    } finally {
      this.activePipelines.delete(request_id);
      this.abortControllers.delete(request_id);
    }
  }

  async stop(requestId: string): Promise<void> {
    this.abortControllers.get(requestId)?.abort();
  }

  getStatus(requestId: string): PipelineState | undefined {
    return this.states.get(requestId);
  }

  isRunning(requestId: string): boolean {
    return this.activePipelines.has(requestId);
  }

  listAll(): PipelineState[] {
    return Array.from(this.states.values());
  }

  async stopAll(): Promise<void> {
    for (const controller of this.abortControllers.values()) {
      controller.abort();
    }
  }

  // ── Internal helpers ────────────────────────────────────────────

  private async getChangedFiles(worktreePath: string, baseBranch: string): Promise<string[]> {
    try {
      const { stdout } = await execute(
        'git',
        ['diff', '--name-only', `${baseBranch}...HEAD`],
        { cwd: worktreePath, reject: false },
      );
      return stdout.split('\n').filter(Boolean);
    } catch {
      return [];
    }
  }

  private updateStatus(requestId: string, status: PipelineStatus): void {
    this.transitionStatus(requestId, status);
  }

  private transitionStatus(requestId: string, status: PipelineStatus): void {
    const machine = this.machines.get(requestId);
    if (machine) {
      if (!machine.tryTransition(status)) {
        // Invalid transition — log but don't crash the pipeline
        logger.error(
          { requestId, from: machine.state, to: status },
          'Invalid pipeline status transition, forcing state',
        );
      }
    }
    this.updateState(requestId, {
      status: machine?.state ?? status,
      ...(status === 'approved' || status === 'failed' || status === 'error'
        ? { completed_at: new Date().toISOString() }
        : {}),
    });
  }

  private updateState(requestId: string, partial: Partial<PipelineState>): void {
    const current = this.states.get(requestId);
    if (current) {
      this.states.set(requestId, { ...current, ...partial });
    }
  }
}
