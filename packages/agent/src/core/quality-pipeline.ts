/**
 * QualityPipeline — orchestrates multiple quality agents in parallel.
 *
 * Replaces the old "single Claude process using Task tool" approach with
 * direct AgentExecutor calls per agent. Each agent gets its own model/provider,
 * runs in parallel, and returns structured AgentResult objects.
 *
 * Correction cycles are deterministic: re-run agents with status === 'failed'.
 */

import { AgentExecutor, ModelFactory } from '@funny/core/agents';
import type { AgentContext, AgentResult, DiffStats } from '@funny/core/agents';
import type { PipelineRequest, AgentName, Tier } from './types.js';
import type { EventBus } from '../infrastructure/event-bus.js';
import type { PipelineServiceConfig } from '../config/schema.js';
import { resolveAgentRole } from './agent-roles.js';
import { logger } from '../infrastructure/logger.js';

// ── Result type ─────────────────────────────────────────────────

export interface QualityPipelineResult {
  agentResults: AgentResult[];
  correctionsApplied: string[];
  overallStatus: 'passed' | 'failed';
}

// ── QualityPipeline ─────────────────────────────────────────────

export class QualityPipeline {
  private modelFactory: ModelFactory;

  constructor(
    private eventBus: EventBus,
    private config: PipelineServiceConfig,
    private signal?: AbortSignal,
  ) {
    this.modelFactory = new ModelFactory({
      anthropic: {
        apiKey: process.env[config.llm_providers.anthropic.api_key_env],
        baseURL: config.llm_providers.anthropic.base_url || undefined,
      },
      openai: {
        apiKey: process.env[config.llm_providers.openai.api_key_env],
        baseURL: config.llm_providers.openai.base_url || undefined,
      },
      ollama: {
        baseURL: config.llm_providers.ollama.base_url || undefined,
      },
    });
  }

  /**
   * Run the quality pipeline: parallel agents → correction cycles → result.
   */
  async run(
    requestId: string,
    request: PipelineRequest,
    tier: Tier,
    agents: AgentName[],
    diffStats: DiffStats,
  ): Promise<QualityPipelineResult> {
    const baseBranch = request.base_branch ?? this.config.branch.main;

    // Build shared context for all agents
    const context: AgentContext = {
      branch: request.branch,
      worktreePath: request.worktree_path,
      tier,
      diffStats,
      previousResults: [],
      baseBranch,
      metadata: {
        ...request.metadata,
        appUrl: request.config?.appUrl,
      },
    };

    logger.info(
      { requestId, agents, tier, filesChanged: diffStats.files_changed },
      'Starting quality pipeline',
    );

    // Wave 1: run all agents in parallel
    let results = await this.runAgentWave(requestId, agents, context);

    // Correction cycles
    const correctionsApplied: string[] = [];
    const maxCorrections = this.config.auto_correction.max_attempts;

    for (let cycle = 0; cycle < maxCorrections; cycle++) {
      // Check for abort
      if (this.signal?.aborted) break;

      const failed = results.filter((r) => r.status === 'failed');
      if (failed.length === 0) break;

      const failedNames = failed.map((r) => r.agent);
      correctionsApplied.push(`cycle-${cycle + 1}: ${failedNames.join(',')}`);

      logger.info(
        { requestId, cycle: cycle + 1, failedAgents: failedNames },
        'Starting correction cycle',
      );

      await this.eventBus.publish({
        event_type: 'pipeline.correcting',
        request_id: requestId,
        timestamp: new Date().toISOString(),
        data: {
          correction_number: cycle + 1,
          failed_agents: failedNames,
        },
      });

      // Re-run failed agents with accumulated results as context
      const correctionContext: AgentContext = {
        ...context,
        previousResults: results,
      };

      const correctionResults = await this.runAgentWave(
        requestId,
        failedNames as AgentName[],
        correctionContext,
      );

      // Merge corrected results back
      for (const cr of correctionResults) {
        const idx = results.findIndex((r) => r.agent === cr.agent);
        if (idx >= 0) {
          results[idx] = cr;
        } else {
          results.push(cr);
        }
      }
    }

    const hasFailed = results.some((r) => r.status === 'failed');

    logger.info(
      {
        requestId,
        overallStatus: hasFailed ? 'failed' : 'passed',
        agentCount: results.length,
        corrections: correctionsApplied.length,
      },
      'Quality pipeline completed',
    );

    return {
      agentResults: results,
      correctionsApplied,
      overallStatus: hasFailed ? 'failed' : 'passed',
    };
  }

  // ── Agent wave execution ──────────────────────────────────────

  /**
   * Run a set of agents in parallel. Each agent gets its own AgentExecutor.
   */
  private async runAgentWave(
    requestId: string,
    agents: AgentName[],
    context: AgentContext,
  ): Promise<AgentResult[]> {
    const promises = agents.map(async (agentName) => {
      // Resolve role with optional config overrides
      const configOverrides = (this.config.agents as Record<string, any>)[agentName];
      const role = resolveAgentRole(agentName, configOverrides);

      // Emit agent started event
      await this.eventBus.publish({
        event_type: 'pipeline.agent.started',
        request_id: requestId,
        timestamp: new Date().toISOString(),
        data: { agent_name: agentName, model: role.model, provider: role.provider },
      });

      const startTime = Date.now();

      try {
        const model = this.modelFactory.create(role.provider, role.model);
        const executor = new AgentExecutor(model);

        const result = await executor.execute(role, context, {
          signal: this.signal,
        });

        // Emit agent completed event
        await this.eventBus.publish({
          event_type: 'pipeline.agent.completed',
          request_id: requestId,
          timestamp: new Date().toISOString(),
          data: {
            agent_name: agentName,
            status: result.status,
            findings_count: result.findings.length,
            fixes_applied: result.fixes_applied,
            duration_ms: result.metadata.duration_ms,
          },
        });

        logger.info(
          {
            requestId,
            agent: agentName,
            status: result.status,
            findings: result.findings.length,
            fixes: result.fixes_applied,
            durationMs: result.metadata.duration_ms,
          },
          'Agent completed',
        );

        return result;
      } catch (err: any) {
        const durationMs = Date.now() - startTime;

        logger.error(
          { requestId, agent: agentName, err: err.message, durationMs },
          'Agent execution failed',
        );

        // Emit agent failed event
        await this.eventBus.publish({
          event_type: 'pipeline.agent.failed',
          request_id: requestId,
          timestamp: new Date().toISOString(),
          data: {
            agent_name: agentName,
            error: err.message,
            duration_ms: durationMs,
          },
        });

        // Return an error result so the pipeline can continue
        const errorResult: AgentResult = {
          agent: agentName,
          status: 'error',
          findings: [
            {
              severity: 'critical',
              description: `Agent execution error: ${err.message}`,
              fix_applied: false,
            },
          ],
          fixes_applied: 0,
          metadata: {
            duration_ms: durationMs,
            turns_used: 0,
            tokens_used: { input: 0, output: 0 },
            model: role.model,
            provider: role.provider,
          },
        };

        return errorResult;
      }
    });

    // Run all agents in parallel
    return Promise.all(promises);
  }
}
