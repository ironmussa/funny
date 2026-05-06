/**
 * GeminiACPProcess — adapter that wraps the Gemini CLI behind the
 * IAgentProcess EventEmitter interface, communicating via the
 * Agent Client Protocol (ACP) over stdio.
 *
 * Spawns `gemini --acp` as a subprocess and translates
 * ACP session updates into CLIMessage format so that AgentMessageHandler
 * works unchanged (same as SDKClaudeProcess and CodexACPProcess).
 *
 * Uses dynamic import of @agentclientprotocol/sdk so the server doesn't
 * crash if the SDK is not installed.
 *
 * The child process and ACP session are kept alive across turns: the
 * initial prompt is run inline from `runProcess()`, after which the run
 * loop awaits shutdown. Follow-up prompts are issued via `sendPrompt()`
 * which calls `connection.prompt()` on the same session — no respawn,
 * no history replay.
 */

import { spawn, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import { Readable, Writable } from 'stream';

import { createDebugLogger } from '../debug.js';
import { toACPImageBlocks, type ACPImageBlock } from './acp-image.js';
import { toACPMcpServers } from './acp-mcp.js';
import {
  inferACPToolName,
  buildACPToolInput,
  extractACPToolOutput,
  parseACPPreambleTitle,
} from './acp-tool-input.js';
import { BaseAgentProcess, type ResultSubtype } from './base-process.js';
import type { CLIMessage } from './types.js';

const dlog = createDebugLogger('acp-gemini');

// Lazy-loaded SDK types (avoid crash if not installed)
type ACPSDK = typeof import('@agentclientprotocol/sdk');
type ACPClient = import('@agentclientprotocol/sdk').Client;
type ACPAgent = import('@agentclientprotocol/sdk').Agent;
type ACPSessionNotification = import('@agentclientprotocol/sdk').SessionNotification;
type ACPSessionUpdate = import('@agentclientprotocol/sdk').SessionUpdate;
type ACPRequestPermissionRequest = import('@agentclientprotocol/sdk').RequestPermissionRequest;
type ACPRequestPermissionResponse = import('@agentclientprotocol/sdk').RequestPermissionResponse;
type ACPConnection = import('@agentclientprotocol/sdk').ClientSideConnection;

/** Known Gemini CLI built-in tools (ACP doesn't expose a listTools API). */
const GEMINI_BUILTIN_TOOLS = [
  'read_file',
  'write_file',
  'replace',
  'list_directory',
  'glob',
  'grep_search',
  'run_shell_command',
  'web_fetch',
  'google_web_search',
  'codebase_investigator',
  'save_memory',
  'ask_user',
  'activate_skill',
  'cli_help',
];

export class GeminiACPProcess extends BaseAgentProcess {
  private childProcess: ChildProcess | null = null;

  // ── Long-lived per-process state ─────────────────────────────────
  private connection: ACPConnection | null = null;
  private activeSessionId: string | null = null;
  private numTurns = 0;
  private totalCost = 0;
  /** True if the agent advertises `promptCapabilities.image` at init. */
  private supportsImages = false;

  // ── Per-turn state (reset on each runOnePrompt) ──────────────────
  private assistantMsgId: string = randomUUID();
  private accumulatedText = '';
  private toolCallsSeen = new Map<string, string>();
  private lastAssistantText = '';
  /**
   * Buffer for `agent_thought_chunk` text. Gemini streams its internal
   * reasoning as separate thought events that we collapse into a single
   * `Think` tool call (rendered as a collapsible card on the client),
   * matching how Claude extended thinking is displayed.
   */
  private pendingThought: { id: string; text: string } | null = null;

  /** True while loadSession is replaying historical events. */
  private replayingHistory = false;

  private flushPendingThought(): void {
    if (!this.pendingThought) return;
    const { id, text } = this.pendingThought;
    this.pendingThought = null;
    if (!text.trim()) return;

    this.emit('message', {
      type: 'assistant',
      message: {
        id: randomUUID(),
        content: [{ type: 'tool_use', id, name: 'Think', input: { content: text } }],
      },
    } as CLIMessage);

    this.emit('message', {
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: id, content: text }],
      },
    } as CLIMessage);
  }

  // ── Overrides ──────────────────────────────────────────────────

  async kill(): Promise<void> {
    await super.kill();
    if (this.childProcess && !this.childProcess.killed) {
      this.childProcess.kill('SIGTERM');
    }
  }

  /** Multi-turn: re-prompt on the live ACP session. */
  async sendPrompt(prompt: string, images?: unknown[]): Promise<void> {
    return this.enqueuePrompt(prompt, images);
  }

  /** Expose the live ACP session so BaseAgentProcess.steerPrompt can cancel it. */
  protected getCancellableSession() {
    if (!this.connection || !this.activeSessionId) return null;
    const sessionId = this.activeSessionId;
    const conn = this.connection;
    return {
      sessionId,
      cancel: async () => {
        await conn.cancel({ sessionId });
      },
    };
  }

  // ── Provider-specific run loop ─────────────────────────────────

  protected async runProcess(): Promise<void> {
    const tStart = Date.now();
    const t = () => Date.now() - tStart;
    const hasSession = !!this.options.sessionId;

    // Dynamic import — fails gracefully if SDK not installed
    let SDK: ACPSDK;
    try {
      SDK = await import('@agentclientprotocol/sdk');
    } catch {
      throw new Error(
        'ACP SDK not installed. Run: bun add @agentclientprotocol/sdk\n' +
          'Also ensure gemini-cli is installed: npm install -g @google/gemini-cli or see https://github.com/google/gemini-cli',
      );
    }

    const { ClientSideConnection, ndJsonStream } = SDK;

    // Resolve Gemini binary
    const geminiBin = this.resolveGeminiBinary();
    dlog.info('acp-timing: sdk-loaded', {
      ms: t(),
      bin: geminiBin,
      platform: process.platform,
      hasSession,
    });

    // Build CLI args
    const args = ['--acp'];
    if (this.options.model) {
      args.push('--model', this.options.model);
    }

    // Spawn gemini subprocess with stdio pipes.
    // On Windows, shell: true is required to resolve .cmd/.bat wrappers
    // for npm-installed binaries like `gemini`.
    const child = spawn(geminiBin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
      signal: this.abortController.signal,
      shell: process.platform === 'win32',
    });

    this.childProcess = child;

    child.on('error', (err: any) => {
      if (!this._exited && !this.isAborted) {
        if (err.code === 'ENOENT') {
          this.emit(
            'error',
            new Error(
              "'gemini' binary not found in PATH or failed to spawn.\n" +
                'Please install it via: npm install -g @google/gemini-cli\n' +
                'Or see https://github.com/google/gemini-cli for details.',
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
      if (errorText) this.emitErrorToolCall(errorText);
    });

    // If the child exits unexpectedly, wake the run loop so cleanup happens.
    child.on('exit', (code, signal) => {
      dlog.warn('acp-timing: child exit', {
        ms: t(),
        code,
        signal,
        aborted: this.isAborted,
        exited: this._exited,
        sessionReady: !!this.activeSessionId,
        numTurns: this.numTurns,
      });
      if (!this.isAborted && !this._exited) {
        this.abortController.abort();
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
    dlog.info('acp-timing: spawned', { ms: t(), pid: child.pid });

    const outputStream = Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>;
    const inputStream = Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>;
    const stream = ndJsonStream(outputStream, inputStream);

    const acpClient: ACPClient = {
      sessionUpdate: async (params: ACPSessionNotification): Promise<void> => {
        if (this.isAborted) return;
        if (this.replayingHistory) return;
        this.translateUpdate(params.update);
      },

      requestPermission: async (
        params: ACPRequestPermissionRequest,
      ): Promise<ACPRequestPermissionResponse> => {
        const allowOption = params.options.find(
          (opt) => opt.kind === 'allow_once' || opt.kind === 'allow_always',
        );
        if (allowOption) {
          return {
            outcome: { outcome: 'selected', optionId: allowOption.optionId },
          };
        }
        return {
          outcome: { outcome: 'selected', optionId: params.options[0]?.optionId ?? '' },
        };
      },
    };

    const connection = new ClientSideConnection((_agent: ACPAgent) => acpClient, stream);
    this.connection = connection;

    let sessionResponse: Awaited<ReturnType<typeof connection.newSession>> | null = null;

    try {
      // 1. Initialize ACP
      dlog.info('acp-timing: initialize-start', { ms: t() });
      const initResult = await connection.initialize({
        protocolVersion: 1,
        clientInfo: { name: 'funny', version: '1.0.0' },
        clientCapabilities: {},
      });

      const supportsLoadSession = initResult.agentCapabilities?.loadSession === true;
      this.supportsImages = initResult.agentCapabilities?.promptCapabilities?.image === true;
      dlog.info('acp-timing: initialize-done', {
        ms: t(),
        supportsLoadSession,
        supportsImages: this.supportsImages,
      });

      // 2. Resume existing session if possible, else create a new one.
      const mcpServerList = toACPMcpServers(this.options.mcpServers);
      if (this.options.sessionId && supportsLoadSession) {
        dlog.info('acp-timing: loadSession-start', { ms: t(), sessionId: this.options.sessionId });
        this.activeSessionId = this.options.sessionId;
        this.replayingHistory = true;
        try {
          await connection.loadSession({
            sessionId: this.options.sessionId,
            cwd: this.options.cwd,
            mcpServers: mcpServerList,
          });
        } finally {
          this.replayingHistory = false;
        }
        dlog.info('acp-timing: loadSession-done', { ms: t() });
      } else {
        dlog.info('acp-timing: newSession-start', {
          ms: t(),
          mcpServerCount: mcpServerList.length,
        });
        sessionResponse = await connection.newSession({
          cwd: this.options.cwd,
          mcpServers: mcpServerList,
        });
        this.activeSessionId = sessionResponse.sessionId;
        dlog.info('acp-timing: newSession-done', { ms: t(), sessionId: this.activeSessionId });
      }

      // Emit init with the real session id once known so the persisted
      // record matches what gemini-acp wrote to its session store —
      // otherwise resume/loadSession would be looking up a UUID that
      // gemini-acp never assigned.
      this.emitInit(
        this.activeSessionId,
        GEMINI_BUILTIN_TOOLS,
        this.options.model ?? 'gemini-3.1-pro-preview',
        this.options.cwd,
      );

      // Diagnostic — log models the agent advertises (ACP unstable session model API).
      const sessionModels = (sessionResponse as any)?.models;
      if (sessionModels) {
        dlog.info('session/new advertised models', {
          availableModels: JSON.stringify(sessionModels.availableModels),
          currentModelId: sessionModels.currentModelId,
          requestedModel: this.options.model,
        });
      } else if (sessionResponse) {
        dlog.info('session/new response did not include models field', {
          requestedModel: this.options.model,
        });
      }

      dlog.info('acp-timing: handshake-complete', {
        ms: t(),
        sessionId: this.activeSessionId,
        promptLen: this.options.prompt?.length ?? 0,
      });

      // Run initial prompt inline so a setup error surfaces as a failed turn.
      await this.runOnePrompt(this.options.prompt, this.options.images);

      // Stay alive across turns; sendPrompt() reuses this connection.
      await this.awaitShutdown();
    } catch (err: unknown) {
      dlog.error('acp-timing: handshake-or-run failed', {
        ms: t(),
        sessionReady: !!this.activeSessionId,
        aborted: this.isAborted,
        message: err instanceof Error ? err.message : String(err),
      });
      this.flushPendingThought();
      if (!this.isAborted) {
        const errorMessage = this.extractErrorMessage(err);
        this.emitResult({
          sessionId: this.activeSessionId ?? randomUUID(),
          subtype: 'error_during_execution',
          startTime: Date.now(),
          numTurns: this.numTurns,
          totalCost: this.totalCost,
          result: errorMessage,
          errors: [errorMessage],
        });
      }
    } finally {
      if (this.childProcess && !this.childProcess.killed) {
        this.childProcess.kill('SIGTERM');
      }
      this.connection = null;
      this.finalize();
    }
  }

  // ── Per-turn execution ──────────────────────────────────────────

  protected async runOnePrompt(prompt: string, images?: unknown[]): Promise<void> {
    if (!this.connection || !this.activeSessionId) {
      throw new Error('GeminiACPProcess: connection not initialized');
    }

    // Reset per-turn state.
    this.assistantMsgId = randomUUID();
    this.accumulatedText = '';
    this.toolCallsSeen.clear();
    this.lastAssistantText = '';
    this.pendingThought = null;

    const startTime = Date.now();

    // Forward images for this turn only if the agent advertised image support
    // — otherwise gemini would reject the prompt or silently drop the blocks.
    const promptBlocks: Array<{ type: 'text'; text: string } | ACPImageBlock> = [
      { type: 'text', text: prompt },
    ];
    const imageBlocks = toACPImageBlocks(images);
    dlog.info('runOnePrompt image diagnostics', {
      rawImagesType: Array.isArray(images) ? 'array' : typeof images,
      rawImagesCount: Array.isArray(images) ? images.length : 0,
      rawImagesSample:
        Array.isArray(images) && images.length > 0
          ? {
              keys: Object.keys((images[0] as object) ?? {}),
              type: (images[0] as any)?.type,
              hasSource: !!(images[0] as any)?.source,
              sourceKeys: (images[0] as any)?.source
                ? Object.keys((images[0] as any).source)
                : undefined,
              hasTopLevelData: typeof (images[0] as any)?.data === 'string',
              hasTopLevelMime: typeof (images[0] as any)?.mimeType === 'string',
            }
          : null,
      acpBlockCount: imageBlocks.length,
      supportsImages: this.supportsImages,
    });
    if (imageBlocks.length > 0) {
      if (this.supportsImages) {
        promptBlocks.push(...imageBlocks);
      } else {
        dlog.warn('agent does not advertise promptCapabilities.image — dropping images', {
          count: imageBlocks.length,
        });
      }
    }

    try {
      dlog.info('acp-timing: prompt-send', {
        sessionId: this.activeSessionId,
        turn: this.numTurns + 1,
        promptLen: prompt.length,
        imageBlocks: imageBlocks.length,
      });
      const promptResponse = await this.connection.prompt({
        sessionId: this.activeSessionId,
        prompt: promptBlocks,
      });
      dlog.info('acp-timing: prompt-done', {
        sessionId: this.activeSessionId,
        turn: this.numTurns + 1,
        durationMs: Date.now() - startTime,
        stopReason: promptResponse.stopReason,
        hadAssistantText: !!this.lastAssistantText,
        accumulatedLen: this.lastAssistantText.length,
      });

      // Extract usage if available — rough Gemini pricing estimate.
      let turnCost = 0;
      if (promptResponse.usage) {
        const u = promptResponse.usage;
        const inputTokens = u.inputTokens ?? 0;
        const outputTokens = u.outputTokens ?? 0;
        turnCost = (inputTokens * 0.00025 + outputTokens * 0.001) / 1000;
        this.totalCost += turnCost;
      }

      this.numTurns += 1;

      const subtype: ResultSubtype =
        promptResponse.stopReason === 'end_turn'
          ? 'success'
          : promptResponse.stopReason === 'cancelled'
            ? 'error_during_execution'
            : promptResponse.stopReason === 'max_tokens'
              ? 'error_max_turns'
              : 'success';

      this.flushPendingThought();

      this.emitResult({
        sessionId: this.activeSessionId,
        subtype,
        startTime,
        numTurns: this.numTurns,
        totalCost: this.totalCost,
        result: this.lastAssistantText || undefined,
      });
    } catch (err: unknown) {
      dlog.error('acp-timing: prompt-error', {
        sessionId: this.activeSessionId,
        turn: this.numTurns + 1,
        durationMs: Date.now() - startTime,
        aborted: this.isAborted,
        hadAssistantText: !!this.lastAssistantText,
        message: err instanceof Error ? err.message : String(err),
      });
      this.flushPendingThought();
      if (!this.isAborted) {
        const errorMessage = this.extractErrorMessage(err);
        this.emitResult({
          sessionId: this.activeSessionId,
          subtype: 'error_during_execution',
          startTime,
          numTurns: this.numTurns,
          totalCost: this.totalCost,
          result: errorMessage,
          errors: [errorMessage],
        });
      }
    }
  }

  // ── Update translation ──────────────────────────────────────

  /** Translate an ACP SessionUpdate into CLIMessage(s) and update per-turn state. */
  private translateUpdate(update: ACPSessionUpdate): void {
    switch (update.sessionUpdate) {
      case 'agent_thought_chunk': {
        // Buffer the thought — flushed as a Think tool_call when the next
        // non-thought event arrives (matches Claude extended thinking UX).
        const content = update.content;
        if (content.type === 'text' && content.text) {
          if (!this.pendingThought) {
            this.pendingThought = { id: randomUUID(), text: '' };
          }
          this.pendingThought.text += content.text;
        }
        return;
      }

      case 'agent_message_chunk': {
        // Real assistant text — flush any pending thought first so the
        // Think card renders before the response.
        this.flushPendingThought();
        const content = update.content;
        if (content.type === 'text' && content.text) {
          this.accumulatedText += content.text;
          this.emit('message', {
            type: 'assistant',
            message: {
              id: this.assistantMsgId,
              content: [{ type: 'text', text: this.accumulatedText }],
            },
          } as CLIMessage);
          this.lastAssistantText = this.accumulatedText;
        }
        return;
      }

      case 'tool_call': {
        const toolCallId = update.toolCallId;
        if (this.toolCallsSeen.has(toolCallId)) return;

        const acpKind = (update as any).kind as string | undefined;
        const title = update.title || '';

        // Gemini emits "preamble" tool_calls whose title is just
        // `[current working directory …] (reason)` with no real input —
        // narrating intent before the next real tool. Buffer them as Think
        // text so they collapse into a single Think card.
        const preamble = parseACPPreambleTitle(title);
        if (preamble) {
          if (!this.pendingThought) {
            this.pendingThought = { id: randomUUID(), text: '' };
          }
          this.pendingThought.text += (this.pendingThought.text ? '\n' : '') + preamble;
          this.toolCallsSeen.set(toolCallId, 'preamble');
          return;
        }

        this.flushPendingThought();
        const locations = (update as any).locations as
          | Array<{ path: string; line?: number | null }>
          | undefined;
        dlog.debug('tool_call', {
          id: toolCallId,
          kind: acpKind,
          title,
          hasRawInput: update.rawInput != null,
        });
        const toolName = inferACPToolName(acpKind, title);

        this.toolCallsSeen.set(toolCallId, toolName);

        const input = buildACPToolInput(toolName, {
          kind: acpKind,
          title,
          rawInput: update.rawInput,
          locations,
        });

        this.emit('message', {
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
        } as CLIMessage);

        // If the tool_call already carries a completed status and output
        // (Gemini runs tools internally, so this can happen), emit the
        // result immediately without waiting for a separate tool_call_update.
        const tcStatus = (update as any).status as string | undefined;
        if (tcStatus === 'completed' || tcStatus === 'failed') {
          this.toolCallsSeen.set(toolCallId, 'done');
          const tcOutput = extractACPToolOutput(update.rawOutput, (update as any).content, title);
          this.emit('message', {
            type: 'user',
            message: {
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: toolCallId,
                  content: tcOutput,
                },
              ],
            },
          } as CLIMessage);
        }

        // Rotate assistant message id so post-tool text is a separate DB message.
        this.accumulatedText = '';
        this.assistantMsgId = randomUUID();
        return;
      }

      case 'tool_call_update': {
        const toolCallId = update.toolCallId;
        if (this.toolCallsSeen.get(toolCallId) === 'preamble') {
          return;
        }
        this.flushPendingThought();
        dlog.debug('tool_call_update', {
          id: toolCallId,
          status: update.status,
          hasRawOutput: update.rawOutput != null,
          hasContent: !!(update as any).content?.length,
          title: update.title ?? '',
        });

        // Gemini sometimes skips the initial `tool_call` event and goes
        // straight to a completed `tool_call_update`. Without a synthetic
        // tool_use the client has no card to render and the edit appears
        // to happen silently. Emit one now from the update fields.
        if (!this.toolCallsSeen.has(toolCallId)) {
          const acpKind = (update as any).kind as string | undefined;
          const title = update.title || '';
          const locations = (update as any).locations as
            | Array<{ path: string; line?: number | null }>
            | undefined;
          const toolName = inferACPToolName(acpKind, title);
          const input = buildACPToolInput(toolName, {
            kind: acpKind,
            title,
            rawInput: (update as any).rawInput,
            locations,
          });
          this.toolCallsSeen.set(toolCallId, toolName);
          this.emit('message', {
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
          } as CLIMessage);
          // Rotate assistant message id so post-tool text is a separate DB message.
          this.accumulatedText = '';
          this.assistantMsgId = randomUUID();
        }

        if (update.status === 'completed' || update.status === 'failed') {
          this.toolCallsSeen.set(toolCallId, 'done');
          const output = extractACPToolOutput(
            update.rawOutput,
            (update as any).content,
            update.title || '',
          );
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
        return;
      }

      case 'plan': {
        this.flushPendingThought();
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
          for (const [tcId, tcState] of this.toolCallsSeen) {
            if (tcState === 'Task') {
              this.toolCallsSeen.set(tcId, 'done');
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

          // Plan text is a standalone block — don't mix with accumulated text
          this.emit('message', {
            type: 'assistant',
            message: {
              id: this.assistantMsgId,
              content: [{ type: 'text', text: `**Plan:**\n${planText}` }],
            },
          } as CLIMessage);
        }
        return;
      }

      // Ignore other update types (available_commands_update, current_mode_update, etc.)
      default:
        return;
    }
  }

  // ── Binary resolution ───────────────────────────────────────

  private resolveGeminiBinary(): string {
    // 1. GEMINI_BINARY_PATH env var
    const envPath = process.env.GEMINI_BINARY_PATH;
    if (envPath) return envPath;

    // 2. ACP_GEMINI_BIN env var (Python SDK convention)
    const acpEnvPath = process.env.ACP_GEMINI_BIN;
    if (acpEnvPath) return acpEnvPath;

    // 3. Default to 'gemini' in PATH (shell: true in spawn handles .cmd on Windows)
    return 'gemini';
  }
}
