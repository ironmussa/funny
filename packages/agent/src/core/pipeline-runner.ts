/**
 * PipelineRunner — main orchestration for pipeline execution.
 *
 * Uses AgentOrchestrator from @funny/core to manage the Claude process.
 * Translates CLIMessages into PipelineEvents and publishes them on the EventBus.
 */

import { AgentOrchestrator, defaultProcessFactory } from '@funny/core/agents';
import type { IAgentProcessFactory } from '@funny/core/agents';
import type {
  PipelineRequest,
  PipelineState,
  PipelineStatus,
  Tier,
  AgentName,
} from './types.js';
import { classifyTier, type TierThresholds } from './tier-classifier.js';
import { buildPipelinePrompt } from './prompt-builder.js';
import { PipelineEventMapper } from './event-mapper.js';
import { StateMachine, PIPELINE_TRANSITIONS } from './state-machine.js';
import type { EventBus } from '../infrastructure/event-bus.js';
import type { CircuitBreakers } from '../infrastructure/circuit-breaker.js';
import type { RequestLogger } from '../infrastructure/request-logger.js';
import type { ContainerManager } from '../infrastructure/container-manager.js';
import type { PipelineServiceConfig } from '../config/schema.js';
import { logger } from '../infrastructure/logger.js';

// ── PipelineRunner ──────────────────────────────────────────────

export class PipelineRunner {
  private orchestrator: AgentOrchestrator;
  private states = new Map<string, PipelineState>();
  private machines = new Map<string, StateMachine<PipelineStatus>>();
  private mappers = new Map<string, PipelineEventMapper>();

  constructor(
    private eventBus: EventBus,
    private config: PipelineServiceConfig,
    private circuitBreakers?: CircuitBreakers,
    private requestLogger?: RequestLogger,
    processFactory: IAgentProcessFactory = defaultProcessFactory,
    private containerManager?: ContainerManager,
  ) {
    this.orchestrator = new AgentOrchestrator(processFactory);

    // Wire orchestrator events → pipeline events
    this.orchestrator.on('agent:message', (requestId: string, msg: any) => {
      logger.info({ requestId, msgType: msg.type, msgSubtype: msg.subtype }, 'agent:message received');

      // Forward EVERY CLIMessage as a raw cli_message event so the UI
      // can render tool cards, bash output, etc. — the same as regular threads.
      this.eventBus.publish({
        event_type: 'pipeline.cli_message',
        request_id: requestId,
        timestamp: new Date().toISOString(),
        data: { cli_message: msg },
      });

      const mapper = this.mappers.get(requestId);
      if (!mapper) {
        logger.warn({ requestId }, 'No mapper found for request, dropping message');
        return;
      }

      const event = mapper.map(msg);
      if (event) {
        // Increment events_count
        const state = this.states.get(requestId);
        if (state) {
          this.updateState(requestId, { events_count: state.events_count + 1 });
        }
        // Handle correction cycle detection
        if (event.event_type === 'pipeline.correcting') {
          this.transitionStatus(requestId, 'correcting');
          const state = this.states.get(requestId);
          if (state) {
            this.updateState(requestId, {
              corrections_count: mapper.corrections,
            });
          }
          this.requestLogger?.warn('pipeline.correction', requestId, 'correction_started', `Correction cycle ${mapper.corrections}`, { correction_number: mapper.corrections });
        }

        // Enrich terminal events with request metadata for downstream consumers (Manifest Writer)
        if (event.event_type === 'pipeline.completed' || event.event_type === 'pipeline.failed') {
          const state = this.states.get(requestId);
          if (state) {
            event.data = {
              ...event.data,
              branch: state.request.branch,
              pipeline_branch: state.pipeline_branch,
              worktree_path: state.request.worktree_path,
              base_branch: state.request.base_branch ?? this.config.branch.main,
              tier: state.tier,
              corrections_applied: state.corrections_applied,
            };
            event.metadata = state.request.metadata;
          }
        }

        this.eventBus.publish(event);

        // Update state based on event
        if (event.event_type === 'pipeline.completed') {
          this.updateStatus(requestId, 'approved');
        } else if (event.event_type === 'pipeline.failed') {
          this.updateStatus(requestId, 'failed');
        } else if (event.event_type === 'pipeline.agent.started' && mapper.isCorrecting) {
          // Re-running agents after correction → transition back to running
          this.transitionStatus(requestId, 'running');
        }
      }
    });

    this.orchestrator.on('agent:error', (requestId: string, err: Error) => {
      logger.error({ requestId, err: err.message }, 'Pipeline agent error');
      this.requestLogger?.error('pipeline.agent', requestId, 'agent_error', err.message, { error: err.message });
      this.updateStatus(requestId, 'error');
      this.eventBus.publish({
        event_type: 'pipeline.failed',
        request_id: requestId,
        timestamp: new Date().toISOString(),
        data: { error: err.message },
      });
    });

    this.orchestrator.on('agent:unexpected-exit', (requestId: string) => {
      logger.warn({ requestId }, 'Pipeline agent exited unexpectedly');
      this.updateStatus(requestId, 'error');
      this.eventBus.publish({
        event_type: 'pipeline.failed',
        request_id: requestId,
        timestamp: new Date().toISOString(),
        data: { error: 'Agent process exited unexpectedly' },
      });
    });

    this.orchestrator.on('agent:stopped', (requestId: string) => {
      this.updateStatus(requestId, 'failed');
      this.eventBus.publish({
        event_type: 'pipeline.stopped',
        request_id: requestId,
        timestamp: new Date().toISOString(),
        data: {},
      });
    });
  }

  // ── Public API ──────────────────────────────────────────────────

  async run(request: PipelineRequest): Promise<void> {
    const { request_id } = request;
    const baseBranch = request.base_branch ?? this.config.branch.main;
    const pipelinePrefix = this.config.branch.pipeline_prefix;

    // Initialize state + FSM + event mapper
    const machine = new StateMachine(PIPELINE_TRANSITIONS, 'accepted' as PipelineStatus, `pipeline:${request_id}`);
    this.machines.set(request_id, machine);
    this.mappers.set(request_id, new PipelineEventMapper(request_id));
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

    // Publish accepted event
    await this.eventBus.publish({
      event_type: 'pipeline.accepted',
      request_id,
      timestamp: new Date().toISOString(),
      data: { branch: request.branch, worktree_path: request.worktree_path },
    });
    this.requestLogger?.info('pipeline.runner', request_id, 'accepted', `Pipeline accepted for branch ${request.branch}`, { branch: request.branch, worktree_path: request.worktree_path });

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
      });

      logger.info({ requestId: request_id, tier, stats }, 'Tier classified');
      this.requestLogger?.info('pipeline.runner', request_id, 'tier_classified', `Classified as ${tier}`, { tier, stats });

      // 2. Container infrastructure — ALWAYS start sandbox (Podman required)
      let mcpServers: Record<string, any> | undefined;
      let spawnClaudeCodeProcess: ((options: any) => any) | undefined;

      if (this.containerManager) {
        const containerResult = await this.containerManager.setup(request.worktree_path, request_id);
        spawnClaudeCodeProcess = containerResult.spawnClaudeCodeProcess;
        mcpServers = containerResult.mcpServers;

        await this.eventBus.publish({
          event_type: 'pipeline.containers.ready',
          request_id,
          timestamp: new Date().toISOString(),
          data: { worktree_path: request.worktree_path, has_browser: !!mcpServers },
        });
        this.requestLogger?.info('pipeline.runner', request_id, 'containers_ready', 'Sandbox ready' + (mcpServers ? ', CDP browser created' : ''));
      }

      // 4. Start the agent via orchestrator (wrapped in circuit breaker)
      // cwd is /workspace inside the container (worktree is mounted there)
      const { model, permissionMode, maxTurns } = this.config.agents.pipeline;
      const agentCwd = spawnClaudeCodeProcess ? '/workspace' : request.worktree_path;

      // 3. Build prompt using config agent lists
      // Use the effective cwd in the prompt so the agent sees /workspace, not the host path
      const tierAgents: Record<Tier, AgentName[]> = {
        small: this.config.tiers.small.agents as AgentName[],
        medium: this.config.tiers.medium.agents as AgentName[],
        large: this.config.tiers.large.agents as AgentName[],
      };
      const promptRequest = spawnClaudeCodeProcess
        ? { ...request, worktree_path: agentCwd }
        : request;
      const prompt = buildPipelinePrompt(
        promptRequest,
        tier,
        tierAgents,
        this.config.auto_correction.max_attempts,
        pipelinePrefix,
        !!mcpServers,
      );
      const startAgent = () => this.orchestrator.startAgent({
        threadId: request_id,
        prompt,
        cwd: agentCwd,
        model: (request.config?.model as any) ?? model,
        permissionMode: permissionMode as any,
        maxTurns: request.config?.maxTurns ?? maxTurns,
        mcpServers,
        spawnClaudeCodeProcess,
      });

      if (this.circuitBreakers) {
        await this.circuitBreakers.claude.execute(startAgent);
      } else {
        await startAgent();
      }
    } catch (err: any) {
      logger.error({ requestId: request_id, err: err.message }, 'Failed to start pipeline');
      this.requestLogger?.error('pipeline.runner', request_id, 'start_failed', err.message, { error: err.message });
      this.updateStatus(request_id, 'error');
      await this.eventBus.publish({
        event_type: 'pipeline.failed',
        request_id,
        timestamp: new Date().toISOString(),
        data: { error: err.message },
      });
    }
  }

  async stop(requestId: string): Promise<void> {
    await this.orchestrator.stopAgent(requestId);
  }

  getStatus(requestId: string): PipelineState | undefined {
    return this.states.get(requestId);
  }

  isRunning(requestId: string): boolean {
    return this.orchestrator.isRunning(requestId);
  }

  listAll(): PipelineState[] {
    return Array.from(this.states.values());
  }

  async stopAll(): Promise<void> {
    await this.orchestrator.stopAll();
  }

  // ── Internal helpers ────────────────────────────────────────────

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
