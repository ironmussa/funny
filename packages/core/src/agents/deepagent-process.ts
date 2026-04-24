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
import { existsSync, mkdirSync, readdirSync, symlinkSync } from 'fs';
import { dirname, join as pathJoin, resolve as pathResolve } from 'path';
import { Readable, Writable } from 'stream';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

import { inferACPToolName, buildACPToolInput, extractACPToolOutput } from './acp-tool-input.js';
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

  // Accumulate thought chunks — emitted as a Think tool call
  private accumulatedThought = '';
  private thinkToolCallId: string | null = null;

  // Track whether the last emitted event was a tool_call so that
  // consecutive tool calls share the same assistantMsgId (and thus the
  // same parent DB message), while new text after tool calls starts fresh.
  private lastEmittedToolCall = false;

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
    // Pass workspace root explicitly so the custom server knows the project dir
    if (this.options.cwd) {
      args.push('--workspace', this.options.cwd);
    }

    // Pass agent template fields as CLI args
    if (this.options.agentName) {
      args.push('--name', this.options.agentName);
    }
    if (this.options.customSkillPaths?.length) {
      args.push('--skills', this.options.customSkillPaths.join(','));
    }
    // Build env — alias provider API keys so that LangChain integrations
    // (used internally by deepagents-acp) can find them.
    const spawnEnv = { ...process.env, ...this.options.env };

    // Pass system prompt via env var (CLI args have length limits)
    if (this.options.systemPrefix) {
      spawnEnv.DEEPAGENT_SYSTEM_PROMPT = this.options.systemPrefix;
    }

    // Pass disabled built-in skills as env var (comma-separated)
    if (this.options.builtinSkillsDisabled?.length) {
      spawnEnv.DEEPAGENT_DISABLED_SKILLS = this.options.builtinSkillsDisabled.join(',');
    }

    // Increase Node.js heap limit for the subprocess to prevent OOM crashes
    // during long-running sessions. Default Node limit (~2GB) is too low.
    const existingNodeOpts = spawnEnv.NODE_OPTIONS ?? '';
    if (!existingNodeOpts.includes('--max-old-space-size')) {
      spawnEnv.NODE_OPTIONS = `${existingNodeOpts} --max-old-space-size=8192`.trim();
    }
    if (spawnEnv.GEMINI_API_KEY && !spawnEnv.GOOGLE_API_KEY) {
      spawnEnv.GOOGLE_API_KEY = spawnEnv.GEMINI_API_KEY;
    }

    // MiniMax models use the OpenAI-compatible API via openai: prefix.
    // Route MINIMAX_API_KEY → OPENAI_API_KEY and set the MiniMax base URL.
    const resolvedModel = this.options.model ?? '';
    const isMinimax = resolvedModel.includes('MiniMax');
    if (isMinimax) {
      if (spawnEnv.MINIMAX_API_KEY && !spawnEnv.OPENAI_API_KEY) {
        spawnEnv.OPENAI_API_KEY = spawnEnv.MINIMAX_API_KEY;
      }
      if (!spawnEnv.OPENAI_BASE_URL) {
        spawnEnv.OPENAI_BASE_URL = 'https://api.minimax.io/v1';
      }
    }

    // xAI Grok models use the OpenAI-compatible API via openai: prefix.
    // Route XAI_API_KEY → OPENAI_API_KEY and set the xAI base URL.
    const isXai = resolvedModel.includes('grok');
    if (isXai) {
      if (spawnEnv.XAI_API_KEY && !spawnEnv.OPENAI_API_KEY) {
        spawnEnv.OPENAI_API_KEY = spawnEnv.XAI_API_KEY;
      }
      if (!spawnEnv.OPENAI_BASE_URL) {
        spawnEnv.OPENAI_BASE_URL = 'https://api.x.ai/v1';
      }
    }

    // Zhipu AI GLM models use the OpenAI-compatible API via openai: prefix.
    // Route ZHIPUAI_API_KEY → OPENAI_API_KEY and set the Z.AI base URL.
    const isGlm = resolvedModel.includes('glm');
    if (isGlm) {
      if (spawnEnv.ZHIPUAI_API_KEY && !spawnEnv.OPENAI_API_KEY) {
        spawnEnv.OPENAI_API_KEY = spawnEnv.ZHIPUAI_API_KEY;
      }
      if (!spawnEnv.OPENAI_BASE_URL) {
        spawnEnv.OPENAI_BASE_URL = 'https://api.z.ai/api/coding/paas/v4';
      }
    }

    // Ensure LangChain provider packages (e.g. @langchain/openai) are resolvable
    // by the subprocess. Bun's flat package layout isolates each dependency, so
    // langchain can't find @langchain/openai even if it's installed at the root.
    // We fix this by ensuring a symlink exists in the langchain package's
    // node_modules/@langchain directory.
    this.ensureLangChainPeerLinks();

    // Spawn deepagents-acp subprocess with stdio pipes
    const child = spawn(bin.command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: this.options.cwd,
      env: spawnEnv,
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

    // Surface stderr errors as tool call cards so they appear in the thread
    // with full history. ACP subprocesses write JSON-RPC errors and API errors
    // to stderr — these are critical for the user (rate limits, auth failures, etc.).
    child.stderr?.on('data', (data: Buffer) => {
      const raw = data.toString().trim();
      if (!raw) return;

      const errorText = this.parseStderrError(raw);
      if (errorText) {
        this.emitErrorToolCall(errorText);
      }
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

    // Reset thought accumulation and tool-call grouping for this run
    this.accumulatedThought = '';
    this.thinkToolCallId = null;
    this.lastEmittedToolCall = false;

    // Track tool calls for deduplication and pending state.
    // Value: tool name while pending, 'done' after result emitted.
    const toolCallsSeen = new Map<string, string>();

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
      // MCP servers can be injected via agent templates or project config
      const mcpServerList = this.options.mcpServers ? Object.values(this.options.mcpServers) : [];
      const sessionResponse = await connection.newSession({
        cwd: this.options.cwd,
        mcpServers: mcpServerList,
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
    } catch (err: unknown) {
      if (!this.isAborted) {
        const errorMessage = this.extractErrorMessage(err);
        this.emitResult({
          sessionId,
          subtype: 'error_during_execution',
          startTime,
          numTurns,
          totalCost,
          result: errorMessage,
          errors: [errorMessage],
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
   * Translate an ACP SessionUpdate into CLIMessage(s).
   * Returns the updated accumulated text and assistant message ID.
   */
  private translateUpdate(
    update: ACPSessionUpdate,
    assistantMsgId: string,
    toolCallsSeen: Map<string, string>,
    accumulatedText: string,
  ): { text: string; msgId: string } {
    const ret = (text: string, msgId?: string) => ({ text, msgId: msgId ?? assistantMsgId });

    // Log non-streaming ACP update types at debug level (skip noise like available_commands_update)
    if (
      update.sessionUpdate !== 'agent_message_chunk' &&
      update.sessionUpdate !== 'agent_thought_chunk' &&
      update.sessionUpdate !== 'available_commands_update' &&
      update.sessionUpdate !== 'current_mode_update'
    ) {
      console.debug(
        `[deepagent-acp] update: ${update.sessionUpdate}`,
        JSON.stringify(update).slice(0, 500),
      );
    }

    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        // After tool calls, start a new message so new text doesn't merge
        // with the tool-call parent message from the previous turn.
        if (this.lastEmittedToolCall) {
          assistantMsgId = randomUUID();
          accumulatedText = '';
          this.lastEmittedToolCall = false;
        }
        const content = update.content;
        if (content.type === 'text' && content.text) {
          accumulatedText += content.text;

          // Extract <think>...</think> blocks from the accumulated text.
          // MiniMax embeds thinking inside regular message text rather than
          // using agent_thought_chunk events.
          const { cleaned, thoughts } = DeepAgentProcess.extractThinkBlocks(accumulatedText);

          // Emit any extracted thoughts as Think tool calls
          if (thoughts.length > 0) {
            const thoughtText = thoughts.join('\n\n');
            this.accumulatedThought = thoughtText;

            if (!this.thinkToolCallId) {
              this.thinkToolCallId = randomUUID();
              toolCallsSeen.set(this.thinkToolCallId, 'Think');
            }
          }

          // Build a single assistant message with both Think (as tool_use)
          // and visible text (as text block) so they land in the same DB row.
          // This prevents ordering issues when loading from DB on refresh.
          const contentBlocks: any[] = [];

          if (this.thinkToolCallId && this.accumulatedThought) {
            contentBlocks.push({
              type: 'tool_use',
              id: this.thinkToolCallId,
              name: 'Think',
              input: { content: this.accumulatedThought },
            });
          }

          const visibleText = cleaned.trim();
          if (visibleText) {
            contentBlocks.push({ type: 'text', text: visibleText });
          }

          if (contentBlocks.length > 0) {
            this.emit('message', {
              type: 'assistant',
              message: {
                id: assistantMsgId,
                content: contentBlocks,
              },
            } as CLIMessage);
          }

          // Emit tool result for completed Think blocks
          if (this.thinkToolCallId && thoughts.length > 0) {
            const thoughtText = thoughts.join('\n\n');
            toolCallsSeen.set(this.thinkToolCallId, 'done');
            this.emit('message', {
              type: 'user',
              message: {
                content: [
                  {
                    type: 'tool_result',
                    tool_use_id: this.thinkToolCallId,
                    content: thoughtText,
                  },
                ],
              },
            } as CLIMessage);
          }
        }
        return ret(accumulatedText);
      }

      case 'agent_thought_chunk': {
        // After tool calls, start a new message for new thoughts.
        if (this.lastEmittedToolCall) {
          assistantMsgId = randomUUID();
          accumulatedText = '';
          this.lastEmittedToolCall = false;
        }
        // Emit thoughts as a dedicated Think tool call so they render
        // in a collapsible ThinkCard instead of mixing with assistant text.
        const content = update.content;
        if (content.type === 'text' && content.text) {
          this.accumulatedThought += content.text;

          // Create the Think tool call ID on first chunk
          if (!this.thinkToolCallId) {
            this.thinkToolCallId = randomUUID();
            toolCallsSeen.set(this.thinkToolCallId, 'Think');
          }

          // Build a single assistant message combining Think + any visible text.
          // This ensures Think and text always share the same DB message row,
          // preventing ordering issues on refresh.
          const contentBlocks: any[] = [
            {
              type: 'tool_use',
              id: this.thinkToolCallId,
              name: 'Think',
              input: { content: this.accumulatedThought },
            },
          ];

          // Include visible text if we already have some from agent_message_chunk
          const { cleaned } = DeepAgentProcess.extractThinkBlocks(accumulatedText);
          const visibleText = cleaned.trim();
          if (visibleText) {
            contentBlocks.push({ type: 'text', text: visibleText });
          }

          this.emit('message', {
            type: 'assistant',
            message: {
              id: assistantMsgId,
              content: contentBlocks,
            },
          } as CLIMessage);

          // Update the tool result with accumulated thought content
          toolCallsSeen.set(this.thinkToolCallId, 'done');
          this.emit('message', {
            type: 'user',
            message: {
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: this.thinkToolCallId,
                  content: this.accumulatedThought,
                },
              ],
            },
          } as CLIMessage);
        }
        return ret(accumulatedText);
      }

      case 'tool_call': {
        const toolCallId = update.toolCallId;
        if (toolCallsSeen.has(toolCallId)) return ret(accumulatedText);

        const acpKind = (update as any).kind as string | undefined;
        const title = update.title || '';
        const locations = (update as any).locations as
          | Array<{ path: string; line?: number | null }>
          | undefined;
        const toolName = inferACPToolName(acpKind, title, { thinkToolName: 'Think' });

        toolCallsSeen.set(toolCallId, toolName);

        const input = buildACPToolInput(toolName, {
          kind: acpKind,
          title,
          rawInput: update.rawInput,
          locations,
        });

        // Reuse the current assistantMsgId so consecutive tool calls share
        // the same parent message in the DB (avoids empty message rows).
        const msg: CLIMessage = {
          type: 'assistant',
          message: {
            id: assistantMsgId,
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
        this.lastEmittedToolCall = true;

        // If tool_call already carries a completed result, emit it immediately
        const tcStatus = (update as any).status as string | undefined;
        if (tcStatus === 'completed' || tcStatus === 'failed') {
          toolCallsSeen.set(toolCallId, 'done');
          const output = extractACPToolOutput(update.rawOutput, (update as any).content, title);
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

        // Keep the same assistantMsgId — consecutive tool calls will share
        // this parent. A new ID is generated when text/thought arrives next.
        return ret('', assistantMsgId);
      }

      case 'tool_call_update': {
        const toolCallId = update.toolCallId;
        console.debug(
          `[deepagent-acp] tool_call_update: id=${toolCallId}, status=${update.status}, title=${update.title ?? ''}`,
        );

        if (update.status === 'completed' || update.status === 'failed') {
          toolCallsSeen.set(toolCallId, 'done');
          const output = extractACPToolOutput(
            update.rawOutput,
            (update as any).content,
            update.title || '',
          );
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
        if (this.lastEmittedToolCall) {
          assistantMsgId = randomUUID();
          accumulatedText = '';
          this.lastEmittedToolCall = false;
        }
        const entries = update.entries ?? [];
        if (entries.length > 0) {
          const planText = entries
            .map((e: any, i: number) => {
              const status =
                e.status === 'completed' ? '[x]' : e.status === 'in_progress' ? '[~]' : '[ ]';
              return `${status} ${i + 1}. ${e.title ?? e.description ?? 'Task'}`;
            })
            .join('\n');

          // Close any pending Task (think/switch_mode) tool calls with the plan text
          for (const [tcId, tcState] of toolCallsSeen) {
            if (tcState === 'Task') {
              toolCallsSeen.set(tcId, 'done');
              this.emit('message', {
                type: 'user',
                message: {
                  content: [
                    {
                      type: 'tool_result',
                      tool_use_id: tcId,
                      content: planText,
                    },
                  ],
                },
              } as CLIMessage);
            }
          }

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

  /**
   * Extract completed <think>...</think> blocks from text.
   * Returns the cleaned text (without think blocks) and the extracted thoughts.
   * Partial/unclosed <think> tags at the end are also stripped from the
   * visible text (the user shouldn't see raw `<think>` markup while streaming).
   */
  private static extractThinkBlocks(text: string): { cleaned: string; thoughts: string[] } {
    const thoughts: string[] = [];
    // Match completed <think>...</think> blocks (non-greedy, handles multiline)
    let cleaned = text.replace(/<think>([\s\S]*?)<\/think>/gi, (_match, thought: string) => {
      const trimmed = thought.trim();
      if (trimmed) thoughts.push(trimmed);
      return '';
    });
    // Also strip any trailing unclosed <think>... (partial block still streaming)
    const unclosedIdx = cleaned.search(/<think>/i);
    if (unclosedIdx !== -1) {
      // Extract the partial thought content for display in the ThinkCard
      const partialThought = cleaned.slice(unclosedIdx + '<think>'.length).trim();
      if (partialThought) thoughts.push(partialThought);
      cleaned = cleaned.slice(0, unclosedIdx);
    }
    return { cleaned, thoughts };
  }

  // ── Binary resolution ───────────────────────────────────────

  private resolveBinary(): { command: string; args?: string[] } {
    // 1. DEEPAGENT_BINARY_PATH env var — explicit full path
    const envPath = process.env.DEEPAGENT_BINARY_PATH;
    if (envPath) return { command: envPath };

    // 2. DEEPAGENT_ACP_BIN env var
    const acpEnvPath = process.env.DEEPAGENT_ACP_BIN;
    if (acpEnvPath) return { command: acpEnvPath };

    // 3. Custom funny deep agent server (co-located with this file)
    //    Uses LocalShellBackend + coding-oriented defaults
    const customServer = pathResolve(__dirname, 'deepagent-server.ts');
    if (existsSync(customServer)) {
      return { command: 'bun', args: [customServer] };
    }
    // Also check for compiled .js version (production builds)
    const customServerJs = pathResolve(__dirname, 'deepagent-server.js');
    if (existsSync(customServerJs)) {
      return { command: 'bun', args: [customServerJs] };
    }

    // 4. Try locally installed deepagents-acp binary (from node_modules/.bin)
    const rootNodeModules = this.findRootNodeModules();
    if (rootNodeModules) {
      const localBin = pathJoin(rootNodeModules, '.bin', 'deepagents-acp');
      if (existsSync(localBin)) {
        return { command: localBin };
      }
    }

    // 5. Default: use npx to run deepagents-acp
    return { command: 'npx', args: ['deepagents-acp'] };
  }

  // ── LangChain peer dependency linking ──────────────────────

  /**
   * Bun's flat package layout isolates each dependency in its own
   * `node_modules/.bun/<pkg>/node_modules/` directory. When `langchain`
   * does `await import('@langchain/openai')`, it can only see packages
   * that Bun has symlinked into its isolated node_modules — and
   * `@langchain/openai` is NOT a direct dependency of `langchain` or
   * `deepagents-acp`, so it's missing.
   *
   * This method finds the Bun-managed `langchain` and `deepagents-acp`
   * isolated node_modules directories and creates symlinks to the
   * required `@langchain/*` provider packages so dynamic imports succeed.
   */
  private ensureLangChainPeerLinks(): void {
    // LangChain provider packages needed by the subprocess
    const peersToLink = ['@langchain/openai', '@langchain/google-genai'];

    try {
      // Find the root node_modules/.bun directory by walking up from __dirname.
      // In dev: __dirname = packages/core/src/agents/ (4 levels up)
      // In bundle: __dirname = packages/runtime/dist/ (3 levels up)
      // So we just walk up until we find a node_modules/.bun directory.
      const rootNodeModules = this.findRootNodeModules();
      if (!rootNodeModules) return;
      const bunDir = pathJoin(rootNodeModules, '.bun');

      if (!existsSync(bunDir)) return;

      // Find peer packages' real locations from the top-level node_modules
      const peerPaths = new Map<string, string>();
      for (const peer of peersToLink) {
        const topLevel = pathJoin(rootNodeModules, ...peer.split('/'));
        if (existsSync(topLevel)) {
          peerPaths.set(peer, topLevel);
        }
      }

      if (peerPaths.size === 0) return;

      // Find all langchain-related isolated node_modules directories in .bun/
      // These are directories like: .bun/langchain@x.x.x+hash/node_modules/
      // and .bun/deepagents-acp@x.x.x+hash/node_modules/
      const packagesToPatch = ['langchain@', 'deepagents-acp@', 'deepagents@'];
      let entries: string[];
      try {
        entries = readdirSync(bunDir);
      } catch {
        return;
      }

      for (const entry of entries) {
        if (!packagesToPatch.some((p) => entry.startsWith(p))) continue;

        const isolatedModulesDir = pathJoin(bunDir, entry, 'node_modules');
        if (!existsSync(isolatedModulesDir)) continue;

        for (const [peer, peerPath] of peerPaths) {
          const parts = peer.split('/');
          const targetDir = pathJoin(isolatedModulesDir, ...parts);

          if (existsSync(targetDir)) continue; // Already linked

          // Ensure the scope directory exists (e.g. @langchain/)
          if (parts.length > 1) {
            const scopeDir = pathJoin(isolatedModulesDir, parts[0]);
            if (!existsSync(scopeDir)) {
              mkdirSync(scopeDir, { recursive: true });
            }
          }

          try {
            symlinkSync(peerPath, targetDir, 'dir');
          } catch {
            // Race condition or permissions — non-fatal
          }
        }
      }
    } catch {
      // Non-fatal — if linking fails, the subprocess may still work via NODE_PATH
    }
  }

  /** Walk up from __dirname to find the nearest node_modules/.bun directory. */
  private findRootNodeModules(): string | null {
    let dir = __dirname;
    for (let i = 0; i < 10; i++) {
      const candidate = pathJoin(dir, 'node_modules');
      if (existsSync(pathJoin(candidate, '.bun'))) {
        return candidate;
      }
      const parent = dirname(dir);
      if (parent === dir) break; // reached filesystem root
      dir = parent;
    }
    return null;
  }
}
