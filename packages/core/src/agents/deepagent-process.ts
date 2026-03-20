/**
 * DeepAgentProcess — adapter that wraps the LangChain Deep Agents ACP server
 * behind the IAgentProcess EventEmitter interface, communicating via the
 * Agent Client Protocol (ACP) over stdio.
 *
 * Spawns `npx deepagents-acp` (or a resolved binary) as a subprocess and
 * translates ACP session updates into CLIMessage format so that
 * AgentMessageHandler works unchanged.
 *
 * Deep Agents manages its own agentic loop (planning, filesystem, subagents,
 * memory, summarization) internally — funny only needs to relay the events.
 *
 * Uses dynamic import of @agentclientprotocol/sdk so the server doesn't
 * crash if the SDK is not installed.
 */

import { spawn, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import { Readable, Writable } from 'stream';

import { BaseAgentProcess, type ResultSubtype } from './base-process.js';
import type { CLIMessage } from './types.js';

// Lazy-loaded SDK types (avoid crash if not installed)
type ACPSDK = typeof import('@agentclientprotocol/sdk');
type ACPClient = import('@agentclientprotocol/sdk').Client;
type ACPAgent = import('@agentclientprotocol/sdk').Agent;
type ACPSessionNotification = import('@agentclientprotocol/sdk').SessionNotification;
type ACPSessionUpdate = import('@agentclientprotocol/sdk').SessionUpdate;
type ACPRequestPermissionRequest = import('@agentclientprotocol/sdk').RequestPermissionRequest;
type ACPRequestPermissionResponse = import('@agentclientprotocol/sdk').RequestPermissionResponse;

/** Known Deep Agents built-in tools. */
const DEEPAGENT_BUILTIN_TOOLS = [
  'read_file',
  'write_file',
  'edit_file',
  'ls',
  'glob',
  'grep',
  'execute',
  'task',
  'write_todos',
  'compact_conversation',
];

export class DeepAgentProcess extends BaseAgentProcess {
  private childProcess: ChildProcess | null = null;

  // ── Overrides ──────────────────────────────────────────────────

  async kill(): Promise<void> {
    await super.kill();
    if (this.childProcess && !this.childProcess.killed) {
      this.childProcess.kill('SIGTERM');
    }
  }

  // ── Provider-specific run loop ─────────────────────────────────

  protected async runProcess(): Promise<void> {
    // Dynamic import — fails gracefully if SDK not installed
    let SDK: ACPSDK;
    try {
      SDK = await import('@agentclientprotocol/sdk');
    } catch {
      throw new Error(
        'ACP SDK not installed. Run: bun add @agentclientprotocol/sdk\n' +
          'Also ensure deepagents-acp is installed: npm install -g deepagents-acp',
      );
    }

    const { ClientSideConnection, ndJsonStream } = SDK;

    // Resolve binary
    const bin = this.resolveBinary();

    // Build CLI args — pass the model via --model flag
    const args = bin.args ? [...bin.args] : [];
    if (this.options.model) {
      args.push('--model', this.options.model);
    }

    // Spawn deepagents-acp subprocess with stdio pipes
    const child = spawn(bin.command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
      signal: this.abortController.signal,
      shell: process.platform === 'win32',
    });

    this.childProcess = child;

    // Handle process errors
    child.on('error', (err: any) => {
      if (!this._exited && !this.isAborted) {
        if (err.code === 'ENOENT') {
          this.emit(
            'error',
            new Error(
              "'deepagents-acp' binary not found.\n" +
                'Install it via: npm install -g deepagents-acp\n' +
                'Or see https://github.com/langchain-ai/deepagents for details.',
            ),
          );
        } else {
          this.emit('error', err);
        }
      }
    });

    // Pipe stderr to console for debugging
    child.stderr?.on('data', (data: Buffer) => {
      console.error('[deepagent-acp:stderr]', data.toString());
    });

    try {
      await new Promise<void>((resolve, reject) => {
        child.on('spawn', resolve);
        child.on('error', reject);
      });
    } catch {
      this._exited = true;
      return;
    }

    // Convert Node streams to Web streams for ACP SDK
    const outputStream = Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>;
    const inputStream = Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>;

    // Create ACP NDJSON stream
    const stream = ndJsonStream(outputStream, inputStream);

    const sessionId = this.options.sessionId ?? randomUUID();
    const startTime = Date.now();
    let numTurns = 0;
    let totalCost = 0;

    // Current assistant message ID — rotated after each tool call
    let assistantMsgId = randomUUID();

    // Accumulate text chunks so we emit the full content, not just deltas
    let accumulatedText = '';

    // Track tool calls for deduplication
    const toolCallsSeen = new Map<string, boolean>();

    // Create ACP client implementation
    const acpClient: ACPClient = {
      sessionUpdate: async (params: ACPSessionNotification): Promise<void> => {
        if (this.isAborted) return;

        const update = params.update;
        const result = this.translateUpdate(update, assistantMsgId, toolCallsSeen, accumulatedText);
        accumulatedText = result.text;
        assistantMsgId = result.msgId;
      },

      // Auto-allow all permission requests
      requestPermission: async (
        params: ACPRequestPermissionRequest,
      ): Promise<ACPRequestPermissionResponse> => {
        const allowOption = params.options.find(
          (opt) => opt.kind === 'allow_once' || opt.kind === 'allow_always',
        );

        if (allowOption) {
          return {
            outcome: {
              outcome: 'selected',
              optionId: allowOption.optionId,
            },
          };
        }

        return {
          outcome: {
            outcome: 'selected',
            optionId: params.options[0]?.optionId ?? '',
          },
        };
      },
    };

    // Create client-side ACP connection
    const connection = new ClientSideConnection((_agent: ACPAgent) => acpClient, stream);

    // Emit init message
    this.emitInit(
      sessionId,
      DEEPAGENT_BUILTIN_TOOLS,
      this.options.model ?? 'minimax-m2.7',
      this.options.cwd,
    );

    try {
      // Step 1: Initialize the ACP connection
      await connection.initialize({
        protocolVersion: 1,
        clientInfo: { name: 'funny', version: '1.0.0' },
        clientCapabilities: {},
      });

      // Step 2: Create a new session
      const sessionResponse = await connection.newSession({
        cwd: this.options.cwd,
        mcpServers: [],
      });

      // Step 3: Send the prompt
      const promptResponse = await connection.prompt({
        sessionId: sessionResponse.sessionId,
        prompt: [{ type: 'text', text: this.options.prompt }],
      });

      // Extract usage if available
      if (promptResponse.usage) {
        const u = promptResponse.usage;
        const inputTokens = u.inputTokens ?? 0;
        const outputTokens = u.outputTokens ?? 0;
        // MiniMax M2.7 pricing: $0.30/M input, $1.20/M output
        totalCost = (inputTokens * 0.3 + outputTokens * 1.2) / 1_000_000;
      }

      numTurns = 1;

      const subtype: ResultSubtype =
        promptResponse.stopReason === 'end_turn'
          ? 'success'
          : promptResponse.stopReason === 'cancelled'
            ? 'error_during_execution'
            : promptResponse.stopReason === 'max_tokens'
              ? 'error_max_turns'
              : 'success';

      this.emitResult({
        sessionId,
        subtype,
        startTime,
        numTurns,
        totalCost,
        result: accumulatedText || undefined,
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
      if (this.childProcess && !this.childProcess.killed) {
        this.childProcess.kill('SIGTERM');
      }
      this.finalize();
    }
  }

  // ── Update translation ──────────────────────────────────────

  /**
   * Map ACP tool kind/title to a normalized tool name for the UI.
   * Deep Agents uses well-known tool names, so we map them directly.
   */
  private static inferToolName(kind: string | undefined, title: string): string {
    switch (kind) {
      case 'read':
        return 'Read';
      case 'edit':
        return 'Edit';
      case 'delete':
        return 'Edit';
      case 'search':
        if (title.includes(' in ') || /\bin\b.*within/.test(title)) return 'Grep';
        if (title.includes('*') || title.includes('?')) return 'Glob';
        return 'Grep';
      case 'execute':
        return 'Bash';
      case 'fetch':
        return 'WebFetch';
      case 'think':
        return 'Task';
      case 'move':
        return 'Bash';
      case 'switch_mode':
        return 'Task';
    }

    // Heuristic fallback
    const titleLower = title.toLowerCase();
    if (titleLower.includes('read_file') || titleLower.includes('read file')) return 'Read';
    if (titleLower.includes('write_file') || titleLower.includes('write file')) return 'Edit';
    if (titleLower.includes('edit_file') || titleLower.includes('edit file')) return 'Edit';
    if (titleLower.includes('execute') || titleLower.includes('shell')) return 'Bash';
    if (titleLower.includes('glob')) return 'Glob';
    if (titleLower.includes('grep')) return 'Grep';
    if (titleLower.includes('task') || titleLower.includes('subagent')) return 'Task';
    if (titleLower.includes('todo') || titleLower.includes('plan')) return 'TodoWrite';

    return 'Tool';
  }

  /**
   * Translate an ACP SessionUpdate into CLIMessage(s).
   * Returns the updated accumulated text and assistant message ID.
   */
  private translateUpdate(
    update: ACPSessionUpdate,
    assistantMsgId: string,
    toolCallsSeen: Map<string, boolean>,
    accumulatedText: string,
  ): { text: string; msgId: string } {
    const ret = (text: string, msgId?: string) => ({ text, msgId: msgId ?? assistantMsgId });

    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
      case 'agent_thought_chunk': {
        const content = update.content;
        if (content.type === 'text' && content.text) {
          accumulatedText += content.text;

          const msg: CLIMessage = {
            type: 'assistant',
            message: {
              id: assistantMsgId,
              content: [{ type: 'text', text: accumulatedText }],
            },
          };
          this.emit('message', msg);
        }
        return ret(accumulatedText);
      }

      case 'tool_call': {
        const toolCallId = update.toolCallId;
        if (toolCallsSeen.has(toolCallId)) return ret(accumulatedText);
        toolCallsSeen.set(toolCallId, true);

        const acpKind = (update as any).kind as string | undefined;
        const title = update.title || '';
        const toolName = DeepAgentProcess.inferToolName(acpKind, title);

        let input: Record<string, unknown> = {};
        if (update.rawInput != null && typeof update.rawInput === 'object') {
          input = { ...(update.rawInput as Record<string, unknown>) };
        }
        if (title) {
          input.description = title;
        }

        const msg: CLIMessage = {
          type: 'assistant',
          message: {
            id: randomUUID(),
            content: [
              {
                type: 'tool_use',
                id: toolCallId,
                name: toolName,
                input,
              },
            ],
          },
        };
        this.emit('message', msg);

        // If tool_call already carries a completed result, emit it immediately
        const tcStatus = (update as any).status as string | undefined;
        if (tcStatus === 'completed' || tcStatus === 'failed') {
          const output = this.extractToolOutput(update, title);
          this.emit('message', {
            type: 'user',
            message: {
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: toolCallId,
                  content: output,
                },
              ],
            },
          } as CLIMessage);
        }

        return ret('', randomUUID());
      }

      case 'tool_call_update': {
        const toolCallId = update.toolCallId;

        if (update.status === 'completed' || update.status === 'failed') {
          const output = this.extractToolOutput(update, update.title || '');
          const msg: CLIMessage = {
            type: 'user',
            message: {
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: toolCallId,
                  content: output,
                },
              ],
            },
          };
          this.emit('message', msg);
        }
        return ret(accumulatedText);
      }

      case 'plan': {
        const entries = update.entries ?? [];
        if (entries.length > 0) {
          const planText = entries
            .map((e: any, i: number) => {
              const status =
                e.status === 'completed' ? '[x]' : e.status === 'in_progress' ? '[~]' : '[ ]';
              return `${status} ${i + 1}. ${e.title ?? e.description ?? 'Task'}`;
            })
            .join('\n');

          const msg: CLIMessage = {
            type: 'assistant',
            message: {
              id: assistantMsgId,
              content: [{ type: 'text', text: `**Plan:**\n${planText}` }],
            },
          };
          this.emit('message', msg);
        }
        return ret(accumulatedText);
      }

      default:
        return ret(accumulatedText);
    }
  }

  // ── Helpers ────────────────────────────────────────────────────

  /** Extract tool output from ACP update, handling multiple content formats. */
  private extractToolOutput(update: ACPSessionUpdate, fallbackTitle: string): string {
    const rawOut = update.rawOutput;
    if (rawOut != null) {
      return typeof rawOut === 'string' ? rawOut : JSON.stringify(rawOut);
    }

    if ((update as any).content?.length) {
      const output = ((update as any).content as any[])
        .map((c: any) => {
          if (c.type === 'content' && c.content) {
            const items = Array.isArray(c.content) ? c.content : [c.content];
            return items
              .filter((b: any) => b.type === 'text')
              .map((b: any) => b.text)
              .join('\n');
          }
          if (c.type === 'diff') return c.diff ?? '';
          if (c.type === 'terminal') return c.output ?? '';
          return '';
        })
        .filter(Boolean)
        .join('\n');
      if (output) return output;
    }

    return fallbackTitle || 'Done';
  }

  // ── Binary resolution ───────────────────────────────────────

  private resolveBinary(): { command: string; args?: string[] } {
    // 1. DEEPAGENT_BINARY_PATH env var — explicit full path
    const envPath = process.env.DEEPAGENT_BINARY_PATH;
    if (envPath) return { command: envPath };

    // 2. DEEPAGENT_ACP_BIN env var
    const acpEnvPath = process.env.DEEPAGENT_ACP_BIN;
    if (acpEnvPath) return { command: acpEnvPath };

    // 3. Default: use npx to run deepagents-acp
    return { command: 'npx', args: ['deepagents-acp'] };
  }
}
