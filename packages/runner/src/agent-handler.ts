/**
 * Handles agent lifecycle on the local runner.
 * Spawns Claude CLI / Codex / Gemini processes, streams events to the central server
 * via the WebSocket client.
 */

import { AgentOrchestrator, defaultProcessFactory } from '@funny/core/agents';
import type { WSEvent } from '@funny/shared';
import type { StartAgentPayload } from '@funny/shared/runner-protocol';

import type { RunnerWSClient } from './ws-client.js';

export class AgentHandler {
  private orchestrator: AgentOrchestrator;
  private activeThreads = new Set<string>();

  constructor(private wsClient: RunnerWSClient) {
    this.orchestrator = new AgentOrchestrator(defaultProcessFactory);

    // Bridge orchestrator events → WebSocket stream to central server
    this.orchestrator.on('agent:message', (threadId: string, msg: any) => {
      this.forwardToWS(threadId, msg);
    });

    this.orchestrator.on('agent:error', (threadId: string, err: Error) => {
      console.error(`[agent] Error on thread ${threadId}:`, err.message);
      this.emitWS(threadId, 'agent:error', { error: err.message });
      this.emitWS(threadId, 'agent:status', { status: 'failed' });
      this.activeThreads.delete(threadId);
    });

    this.orchestrator.on('agent:unexpected-exit', (threadId: string) => {
      console.error(`[agent] Unexpected exit on thread ${threadId}`);
      this.emitWS(threadId, 'agent:error', {
        error: 'Agent process exited unexpectedly',
      });
      this.emitWS(threadId, 'agent:status', { status: 'failed' });
      this.activeThreads.delete(threadId);
    });

    this.orchestrator.on('agent:stopped', (threadId: string) => {
      console.info(`[agent] Stopped thread ${threadId}`);
      this.emitWS(threadId, 'agent:status', { status: 'stopped' });
      this.activeThreads.delete(threadId);
    });
  }

  async startAgent(threadId: string, payload: StartAgentPayload): Promise<void> {
    console.info(
      `[agent] Starting agent on thread ${threadId} (${payload.provider}/${payload.model})`,
    );
    this.activeThreads.add(threadId);

    this.emitWS(threadId, 'agent:status', { status: 'running' });

    await this.orchestrator.startAgent({
      threadId,
      prompt: payload.prompt,
      cwd: payload.cwd,
      model: payload.model,
      permissionMode: payload.permissionMode,
      images: payload.images,
      disallowedTools: payload.disallowedTools,
      allowedTools: payload.allowedTools,
      provider: payload.provider,
      sessionId: payload.sessionId,
      systemPrefix: payload.systemPrefix,
    });
  }

  async stopAgent(threadId: string): Promise<void> {
    await this.orchestrator.stopAgent(threadId);
    this.activeThreads.delete(threadId);
  }

  isRunning(threadId: string): boolean {
    return this.orchestrator.isRunning(threadId);
  }

  getActiveThreadIds(): string[] {
    return Array.from(this.activeThreads);
  }

  async stopAll(): Promise<void> {
    await this.orchestrator.stopAll();
    this.activeThreads.clear();
  }

  /**
   * Forward a raw NDJSON message from the agent process.
   * The orchestrator emits these as-is; we parse and re-emit as WSEvents.
   */
  private forwardToWS(threadId: string, msg: any): void {
    // The orchestrator emits structured messages that map to WSEvent types.
    // We reconstruct the WSEvent and send it to central.
    if (msg.type === 'assistant' && msg.message?.content) {
      // Text message
      const text = Array.isArray(msg.message.content)
        ? msg.message.content
            .filter((b: any) => b.type === 'text')
            .map((b: any) => b.text)
            .join('')
        : typeof msg.message.content === 'string'
          ? msg.message.content
          : '';

      if (text) {
        this.emitWS(threadId, 'agent:message', {
          role: 'assistant',
          content: text,
        });
      }

      // Tool uses within the message
      if (Array.isArray(msg.message.content)) {
        for (const block of msg.message.content) {
          if (block.type === 'tool_use') {
            this.emitWS(threadId, 'agent:tool_call', {
              toolCallId: block.id,
              name: block.name,
              input: block.input,
            });
          }
        }
      }
    } else if (msg.type === 'result') {
      this.emitWS(threadId, 'agent:result', {
        status: 'completed',
        cost: msg.cost_usd,
        duration: msg.duration_ms,
        result: msg.result,
      });
      this.activeThreads.delete(threadId);
    } else if (msg.type === 'tool_result') {
      if (msg.tool_result_id) {
        this.emitWS(threadId, 'agent:tool_output', {
          toolCallId: msg.tool_result_id,
          output: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
        });
      }
    }
  }

  private emitWS(threadId: string, type: WSEvent['type'], data: unknown): void {
    const event = { type, threadId, data } as WSEvent;
    this.wsClient.sendAgentEvent(threadId, event);
  }
}
