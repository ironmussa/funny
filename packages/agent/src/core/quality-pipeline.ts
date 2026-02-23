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
import type { StepResult } from 'ai';
import type { PipelineRequest, AgentName, Tier } from './types.js';
import type { EventBus } from '../infrastructure/event-bus.js';
import type { PipelineServiceConfig } from '../config/schema.js';
import { resolveAgentRole } from './agent-roles.js';
import { logger } from '../infrastructure/logger.js';
import { nanoid } from 'nanoid';

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
      'funny-api-acp': {
        apiKey: process.env[config.llm_providers.funny_api_acp.api_key_env],
        baseURL: config.llm_providers.funny_api_acp.base_url || undefined,
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

    const hasFailed = results.some((r) => r.status !== 'passed');

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

  // ── CLI message emission ─────────────────────────────────────

  /**
   * Emit a pipeline.cli_message event wrapping a CLIMessage-shaped payload.
   * The ingest-mapper on the server side processes these to populate the thread
   * with assistant text, tool calls, tool results, and final status.
   */
  private async emitCLIMessage(
    requestId: string,
    cliMessage: Record<string, unknown>,
  ): Promise<void> {
    await this.eventBus.publish({
      event_type: 'pipeline.cli_message',
      request_id: requestId,
      timestamp: new Date().toISOString(),
      data: { cli_message: cliMessage },
    });
  }

  /**
   * Build an onStepFinish callback that translates Vercel AI SDK steps
   * into pipeline.cli_message events (CLIMessage format).
   */
  private createStepCallback(
    requestId: string,
    agentName: string,
  ): (step: StepResult<any>) => void {
    /** Monotonically increasing message ID for this agent's messages */
    let msgCounter = 0;

    return (step: StepResult<any>) => {
      const msgId = `${agentName}-msg-${++msgCounter}`;

      // Build content blocks from the step
      const contentBlocks: Array<Record<string, unknown>> = [];

      // Add text if present
      if (step.text) {
        contentBlocks.push({ type: 'text', text: step.text });
      }

      // Add tool calls
      if (step.toolCalls && step.toolCalls.length > 0) {
        for (const tc of step.toolCalls) {
          contentBlocks.push({
            type: 'tool_use',
            id: tc.toolCallId,
            name: tc.toolName,
            input: tc.args,
          });
        }
      }

      // Emit assistant message with text + tool_use blocks
      if (contentBlocks.length > 0) {
        // Fire and forget — don't await to avoid blocking the AI SDK loop
        this.emitCLIMessage(requestId, {
          type: 'assistant',
          message: {
            id: msgId,
            content: contentBlocks,
          },
        }).catch((err) =>
          logger.error({ err: err.message, requestId, agent: agentName }, 'Failed to emit CLI assistant message'),
        );
      }

      // Emit tool results as user message
      if (step.toolResults && step.toolResults.length > 0) {
        const resultBlocks = step.toolResults.map((tr: any) => ({
          type: 'tool_result',
          tool_use_id: tr.toolCallId,
          content: typeof tr.result === 'string' ? tr.result : JSON.stringify(tr.result),
        }));

        this.emitCLIMessage(requestId, {
          type: 'user',
          message: { content: resultBlocks },
        }).catch((err) =>
          logger.error({ err: err.message, requestId, agent: agentName }, 'Failed to emit CLI tool result'),
        );
      }
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

      // Emit system init CLI message so the thread shows as running
      const sessionId = nanoid();
      await this.emitCLIMessage(requestId, {
        type: 'system',
        subtype: 'init',
        session_id: sessionId,
        tools: role.tools,
        model: role.model,
        cwd: context.worktreePath,
      });

      const startTime = Date.now();

      try {
        const model = this.modelFactory.create(role.provider, role.model);
        const executor = new AgentExecutor(model);

        const result = await executor.execute(role, context, {
          signal: this.signal,
          onStepFinish: this.createStepCallback(requestId, agentName),
        });

        // Emit a final assistant message with the agent's summary
        const summaryText = [
          `**Agent \`${agentName}\`: ${result.status}**`,
          `Findings: ${result.findings.length}, Fixes applied: ${result.fixes_applied}`,
          ...result.findings.map(
            (f, i) => `${i + 1}. [${f.severity}] ${f.description}${f.fix_applied ? ' (fixed)' : ''}`,
          ),
        ].join('\n');

        await this.emitCLIMessage(requestId, {
          type: 'assistant',
          message: {
            id: `${agentName}-summary`,
            content: [{ type: 'text', text: summaryText }],
          },
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
            ...(result.status === 'error' && result.findings.length > 0
              ? { error: result.findings[0].description }
              : {}),
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
