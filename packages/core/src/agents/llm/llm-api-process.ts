/**
 * LLMApiProcess — bridge between the direct HTTP agent system and
 * the existing IAgentProcess interface.
 *
 * Extends BaseAgentProcess so it plugs directly into:
 *   - AgentOrchestrator (start/stop/events)
 *   - PipelineRunner (CLIMessage events)
 *   - AgentRunner on the server (DB persistence, WebSocket)
 *
 * The prompt can be:
 *   1. JSON `{role, context}` — structured pipeline mode
 *   2. Plain text — interactive mode with a default role
 */

import { randomUUID } from 'crypto';
import type { CLIMessage } from '../types.js';
import { BaseAgentProcess, type ResultSubtype } from '../base-process.js';
import { AgentExecutor, type StepInfo } from './agent-executor.js';
import { ModelFactory } from './model-factory.js';
import type { AgentRole, AgentContext, AgentResult } from './agent-context.js';

export class LLMApiProcess extends BaseAgentProcess {
  private modelFactory: ModelFactory;

  constructor(
    options: import('../types.js').ClaudeProcessOptions,
    modelFactory?: ModelFactory,
  ) {
    super(options);
    this.modelFactory = modelFactory ?? new ModelFactory();
  }

  protected async runProcess(): Promise<void> {
    const sessionId = this.options.sessionId ?? randomUUID();
    const startTime = Date.now();
    let numTurns = 0;
    let totalCost = 0;

    try {
      const { role, context } = this.parsePromptPayload();

      // Resolve provider config
      const resolved = this.modelFactory.resolve(role.provider, role.model);

      // Create executor with direct HTTP
      const executor = new AgentExecutor(resolved.baseURL, resolved.modelId, resolved.apiKey);

      // Emit init
      const toolNames = ['bash', 'read', 'edit', 'glob', 'grep'];
      this.emitInit(sessionId, toolNames, role.model, context.worktreePath);

      // Execute with step callbacks for CLIMessage bridging
      const agentResult = await executor.execute(role, context, {
        signal: this.abortController.signal,
        onMessage: (step: StepInfo) => {
          this.emitStepAsCLIMessages(step);
        },
      });

      numTurns = agentResult.metadata.turns_used;
      totalCost = this.estimateCost(agentResult);

      const subtype: ResultSubtype =
        agentResult.status === 'error'
          ? 'error_during_execution'
          : agentResult.status === 'timeout'
            ? 'error_max_turns'
            : 'success';

      this.emitResult({
        sessionId,
        subtype,
        startTime,
        numTurns,
        totalCost,
        result: JSON.stringify(agentResult, null, 2),
      });
    } catch (err: any) {
      if (this.isAborted) return;
      this.emitResult({
        sessionId,
        subtype: 'error_during_execution',
        startTime,
        numTurns,
        totalCost,
        result: err.message,
        errors: [err.message],
      });
    } finally {
      this.finalize();
    }
  }

  // ── Prompt parsing ──────────────────────────────────────────

  private parsePromptPayload(): { role: AgentRole; context: AgentContext } {
    try {
      const parsed = JSON.parse(this.options.prompt);
      if (parsed.role && parsed.context) {
        return { role: parsed.role, context: parsed.context };
      }
    } catch {
      // Not JSON — treat as plain text prompt
    }

    // Default: generic interactive role
    const providerName = this.detectProvider();
    return {
      role: {
        name: 'interactive',
        systemPrompt: 'You are a helpful coding assistant. Answer the user\'s request.',
        model: this.options.model ?? 'claude-sonnet-4-5-20250929',
        provider: providerName,
        tools: [],
        maxTurns: this.options.maxTurns ?? 50,
      },
      context: {
        branch: 'unknown',
        worktreePath: this.options.cwd,
        tier: 'small',
        diffStats: { files_changed: 0, lines_added: 0, lines_deleted: 0, changed_files: [] },
        previousResults: [],
        baseBranch: 'main',
      },
    };
  }

  private detectProvider(): string {
    const model = this.options.model ?? '';
    if (model.includes('claude')) return 'anthropic';
    if (model.includes('gpt') || model.includes('o1') || model.includes('o3') || model.includes('o4')) return 'openai';
    if (model.includes('llama') || model.includes('mistral') || model.includes('codellama')) return 'ollama';
    return 'anthropic';
  }

  // ── CLIMessage emission from agent steps ───────────────────

  private emitStepAsCLIMessages(step: StepInfo): void {
    // Emit assistant text
    if (step.text) {
      const cliMsg: CLIMessage = {
        type: 'assistant',
        message: {
          id: randomUUID(),
          content: [{ type: 'text' as const, text: step.text }],
        },
      };
      this.emit('message', cliMsg);
    }

    // Emit tool calls
    if (step.toolCalls?.length) {
      for (const tc of step.toolCalls) {
        const toolUseMsg: CLIMessage = {
          type: 'assistant',
          message: {
            id: randomUUID(),
            content: [
              {
                type: 'tool_use' as const,
                id: tc.id,
                name: tc.function.name,
                input: JSON.parse(tc.function.arguments),
              },
            ],
          },
        };
        this.emit('message', toolUseMsg);
      }
    }

    // Emit tool results
    if (step.toolResults?.length) {
      for (const tr of step.toolResults) {
        const toolResultMsg: CLIMessage = {
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result' as const,
                tool_use_id: tr.toolCallId,
                content: typeof tr.result === 'string' ? tr.result : JSON.stringify(tr.result),
              },
            ],
          },
        };
        this.emit('message', toolResultMsg);
      }
    }
  }

  // ── Cost estimation ─────────────────────────────────────────

  private estimateCost(result: AgentResult): number {
    const { input, output } = result.metadata.tokens_used;
    const model = result.metadata.model;

    if (model.includes('opus')) return (input * 15 + output * 75) / 1_000_000;
    if (model.includes('sonnet')) return (input * 3 + output * 15) / 1_000_000;
    if (model.includes('haiku')) return (input * 0.25 + output * 1.25) / 1_000_000;
    if (model.includes('gpt-4')) return (input * 10 + output * 30) / 1_000_000;
    if (model.includes('gpt-3.5')) return (input * 0.5 + output * 1.5) / 1_000_000;
    if (model.includes('llama') || model.includes('mistral')) return 0;

    return (input * 3 + output * 15) / 1_000_000;
  }
}
