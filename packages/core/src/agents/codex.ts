/**
 * CodexProcess — adapter that wraps @openai/codex-sdk behind the
 * IAgentProcess EventEmitter interface.
 *
 * Translates Codex SDK events into CLIMessage format so that
 * AgentMessageHandler works unchanged (same as SDKClaudeProcess).
 *
 * Uses dynamic import so the server doesn't crash if @openai/codex-sdk
 * is not installed.
 */

import { randomUUID } from 'crypto';

import { BaseAgentProcess } from './base-process.js';
import type { CLIMessage } from './types.js';

// Lazy-loaded SDK types (avoid crash if not installed)
type CodexSDK = typeof import('@openai/codex-sdk');
type CodexInstance = import('@openai/codex-sdk').Codex;
type CodexThread = Awaited<ReturnType<CodexInstance['startThread']>>;

export class CodexProcess extends BaseAgentProcess {
  private threadId: string | null = null;

  // ── Provider-specific run loop ─────────────────────────────────

  protected async runProcess(): Promise<void> {
    // Dynamic import — fails gracefully if SDK not installed
    let SDK: CodexSDK;
    try {
      SDK = await import('@openai/codex-sdk');
    } catch {
      throw new Error('Codex SDK not installed. Run: npm install @openai/codex-sdk');
    }

    const { Codex } = SDK;

    const codexConfig: Record<string, any> = {};
    if (this.options.model) {
      codexConfig.model = this.options.model;
    }

    const codex = new Codex({ config: codexConfig });

    // Start or resume a thread
    let thread: CodexThread;
    const isResume = !!this.options.sessionId;

    if (isResume) {
      thread = codex.resumeThread(this.options.sessionId!);
    } else {
      thread = codex.startThread({
        workingDirectory: this.options.cwd,
        skipGitRepoCheck: true,
      });
    }

    // Generate a session ID (Codex threads persist to disk at ~/.codex/sessions)
    const sessionId = this.options.sessionId ?? randomUUID();
    this.threadId = sessionId;

    // Emit init message
    this.emitInit(sessionId, [], this.options.model ?? 'o4-mini', this.options.cwd);

    const startTime = Date.now();
    let totalCost = 0;
    let numTurns = 0;
    let lastResult = '';
    const assistantMsgId = randomUUID();

    try {
      const { events } = await thread.runStreamed(this.options.prompt);

      for await (const event of events) {
        if (this.isAborted) break;

        switch (event.type) {
          case 'item.completed': {
            const item = (event as any).item;
            if (!item) break;

            // Translate Codex items to CLIMessage format
            const cliMsg = this.translateItem(item, assistantMsgId);
            if (cliMsg) {
              this.emit('message', cliMsg);
            }

            // Extract text for the final result
            if (item.type === 'message' && item.role === 'assistant') {
              const text = this.extractText(item);
              if (text) lastResult = text;
            }
            break;
          }

          case 'turn.completed': {
            numTurns++;
            const usage = (event as any).usage;
            if (usage) {
              // Estimate cost based on token usage (rough approximation)
              const inputTokens = usage.input_tokens ?? 0;
              const outputTokens = usage.output_tokens ?? 0;
              // Codex pricing is similar to GPT-4o class
              totalCost += (inputTokens * 0.0025 + outputTokens * 0.01) / 1000;
            }
            break;
          }
        }
      }

      // Emit success result
      this.emitResult({
        sessionId,
        subtype: 'success',
        startTime,
        numTurns,
        totalCost,
        result: lastResult || undefined,
      });
    } catch (err: any) {
      if (!this.isAborted) {
        this.emitResult({
          sessionId,
          subtype: 'error_during_execution',
          startTime,
          numTurns,
          totalCost,
          result: err.message,
          errors: [err.message],
        });
      }
    } finally {
      this.finalize();
    }
  }

  // ── Item translation ──────────────────────────────────────────

  private translateItem(item: any, assistantMsgId: string): CLIMessage | null {
    if (!item) return null;

    // Assistant message with text
    if (item.type === 'message' && item.role === 'assistant') {
      const text = this.extractText(item);
      if (!text) return null;

      return {
        type: 'assistant',
        message: {
          id: assistantMsgId,
          content: [{ type: 'text', text }],
        },
      };
    }

    // Function/tool call
    if (item.type === 'function_call' || item.type === 'tool_call') {
      const toolUseId = item.id ?? item.call_id ?? randomUUID();
      const name = item.name ?? item.function?.name ?? 'unknown';
      let input: unknown = {};

      try {
        const args = item.arguments ?? item.function?.arguments;
        input = typeof args === 'string' ? JSON.parse(args) : (args ?? {});
      } catch {
        input = { raw: item.arguments ?? '' };
      }

      // Emit as assistant message with tool_use block
      return {
        type: 'assistant',
        message: {
          id: randomUUID(),
          content: [{ type: 'tool_use', id: toolUseId, name, input }],
        },
      };
    }

    // Function/tool call output
    if (item.type === 'function_call_output' || item.type === 'tool_result') {
      const toolUseId = item.call_id ?? item.tool_use_id ?? '';
      const output =
        typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? '');

      return {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: toolUseId,
              content: output,
            },
          ],
        },
      };
    }

    return null;
  }

  /** Extract text content from a Codex message item. */
  private extractText(item: any): string | null {
    if (typeof item.content === 'string') return item.content;
    if (Array.isArray(item.content)) {
      const texts = item.content
        .filter((c: any) => c.type === 'output_text' || c.type === 'text')
        .map((c: any) => c.text ?? c.content ?? '')
        .filter(Boolean);
      return texts.length > 0 ? texts.join('\n\n') : null;
    }
    return null;
  }
}
