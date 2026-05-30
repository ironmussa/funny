/**
 * CodexACPProcess — adapter that wraps the codex-acp binary
 * (https://github.com/zed-industries/codex-acp) behind the IAgentProcess
 * EventEmitter interface, communicating via the Agent Client Protocol (ACP)
 * over stdio.
 *
 * Spawns `codex-acp` as a subprocess and translates ACP session updates into
 * CLIMessage format so AgentMessageHandler works unchanged (same as
 * GeminiACPProcess).
 *
 *   - Auth via OPENAI_API_KEY / CODEX_API_KEY env vars or the codex-acp
 *     `chatgpt` login flow (handled out-of-band by the user)
 *   - Session resume via `session/load` (capability flag verified at runtime)
 *   - Mode + model selected explicitly after newSession via ACP requests
 *   - Per-tool approvals routed through requestPermission → permissionRuleLookup
 *
 * The child process and ACP session are kept alive across turns: the initial
 * prompt is run inline from `runProcess()`, after which the run loop awaits
 * shutdown. Follow-up prompts are issued via `sendPrompt()` which calls
 * `connection.prompt()` on the same session — no respawn, no replay.
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

const dlog = createDebugLogger('codex-acp');

// Lazy-loaded SDK types (avoid crash if not installed)
type ACPSDK = typeof import('@agentclientprotocol/sdk');
type ACPClient = import('@agentclientprotocol/sdk').Client;
type ACPAgent = import('@agentclientprotocol/sdk').Agent;
type ACPSessionNotification = import('@agentclientprotocol/sdk').SessionNotification;
type ACPSessionUpdate = import('@agentclientprotocol/sdk').SessionUpdate;
type ACPRequestPermissionRequest = import('@agentclientprotocol/sdk').RequestPermissionRequest;
type ACPRequestPermissionResponse = import('@agentclientprotocol/sdk').RequestPermissionResponse;
type ACPConnection = import('@agentclientprotocol/sdk').ClientSideConnection;

/** Approximate list of Codex built-in tools — surfaced via system:init for UI. */
const CODEX_BUILTIN_TOOLS = [
  'read_file',
  'write_file',
  'apply_patch',
  'list_directory',
  'glob',
  'grep',
  'run_shell_command',
  'web_fetch',
];

/** Map funny's permissionMode → codex-acp session mode id. */
function resolveSessionMode(permissionMode: string | undefined): string {
  // codex-acp modes (from probe): read-only | auto | full-access
  if (permissionMode === 'read-only' || permissionMode === 'plan') return 'read-only';
  if (permissionMode === 'full-access' || permissionMode === 'bypassPermissions') {
    return 'full-access';
  }
  return 'auto';
}

/** Fuse `${model}/${effort}` to form a codex-acp modelId. */
function buildCodexModelId(model: string | undefined, effort: string | undefined): string | null {
  if (!model) return null;
  if (model.includes('/')) return model; // already fused
  const e = effort && effort.length > 0 ? effort : 'medium';
  return `${model}/${e}`;
}

export class CodexACPProcess extends BaseAgentProcess {
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
   * Buffer for `agent_thought_chunk` text. Codex streams its internal
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
    let SDK: ACPSDK;
    try {
      SDK = await import('@agentclientprotocol/sdk');
    } catch {
      throw new Error(
        'ACP SDK not installed. Run: bun add @agentclientprotocol/sdk\n' +
          'Also ensure codex-acp is available: npm install -g @zed-industries/codex-acp ' +
          '(or rely on `npx @zed-industries/codex-acp`).',
      );
    }

    const { ClientSideConnection, ndJsonStream } = SDK;

    const { command, args } = this.resolveCodexAcpCommand();

    const child = spawn(command, args, {
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
              "'codex-acp' binary not found in PATH or failed to spawn.\n" +
                'Install via: npm install -g @zed-industries/codex-acp\n' +
                'Or set CODEX_ACP_BINARY_PATH to a custom location.\n' +
                'See https://github.com/zed-industries/codex-acp for details.',
            ),
          );
        } else {
          this.emit('error', err);
        }
      }
    });

    child.stderr?.on('data', (data: Buffer) => {
      const raw = data.toString().trim();
      if (!raw) return;
      const errorText = this.parseStderrError(raw);
      if (errorText) this.emitErrorToolCall(errorText);
    });

    // If the child exits unexpectedly, wake the run loop so cleanup happens.
    child.on('exit', (code, signal) => {
      if (!this.isAborted && !this._exited) {
        dlog.warn('codex-acp child exited unexpectedly', { code, signal });
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

    const outputStream = Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>;
    const inputStream = Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>;
    const stream = ndJsonStream(outputStream, inputStream);

    const acpClient: ACPClient = {
      sessionUpdate: async (params: ACPSessionNotification): Promise<void> => {
        if (this.isAborted) return;
        const update = params.update;
        if (this.replayingHistory && update.sessionUpdate !== 'usage_update') return;
        this.translateUpdate(update);
      },

      requestPermission: async (
        params: ACPRequestPermissionRequest,
      ): Promise<ACPRequestPermissionResponse> => {
        return await this.handleRequestPermission(params);
      },
    };

    const connection = new ClientSideConnection((_agent: ACPAgent) => acpClient, stream);
    this.connection = connection;

    try {
      // 1. Initialize ACP
      const initResult = await connection.initialize({
        protocolVersion: 1,
        clientInfo: { name: 'funny', version: '1.0.0' },
        clientCapabilities: {},
      });

      const supportsLoadSession = initResult.agentCapabilities?.loadSession === true;
      this.supportsImages = initResult.agentCapabilities?.promptCapabilities?.image === true;
      const supportsSetSessionModel =
        (initResult.agentCapabilities as Record<string, unknown> | undefined)?.[
          'unstable_setSessionModel'
        ] === true ||
        (initResult.agentCapabilities as Record<string, unknown> | undefined)?.[
          'setSessionModel'
        ] === true;

      // 2. Resume or create
      const mcpServerList = toACPMcpServers(this.options.mcpServers);
      if (this.options.sessionId && supportsLoadSession) {
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
      } else {
        const ns = await connection.newSession({
          cwd: this.options.cwd,
          mcpServers: mcpServerList,
        });
        this.activeSessionId = ns.sessionId;
      }

      // Emit init with the real session id once known so the persisted
      // record matches what codex-acp wrote to its session store.
      this.emitInit(
        this.activeSessionId,
        CODEX_BUILTIN_TOOLS,
        this.options.model ?? 'gpt-5.4',
        this.options.cwd,
      );

      // 3. Switch session mode (codex-acp default is `read-only`)
      const desiredMode = resolveSessionMode(
        this.options.originalPermissionMode ?? this.options.permissionMode,
      );
      try {
        await connection.setSessionMode({ sessionId: this.activeSessionId, modeId: desiredMode });
      } catch (e) {
        this.emitErrorToolCall(
          `**codex-acp:** unable to switch to session mode "${desiredMode}" — ${this.extractErrorMessage(e)}`,
        );
      }

      // 4. Select model + reasoning effort.
      if (supportsSetSessionModel) {
        const modelId = buildCodexModelId(this.options.model, this.options.effort);
        if (modelId) {
          try {
            await (connection as any).unstable_setSessionModel({
              sessionId: this.activeSessionId,
              modelId,
            });
          } catch (e) {
            this.emitErrorToolCall(
              `**codex-acp:** unable to set model "${modelId}" — ${this.extractErrorMessage(e)}`,
            );
          }
        }
      } else {
        dlog.debug('codex-acp does not advertise unstable_setSessionModel; skipping model select');
      }

      // 5. Run initial prompt inline so a setup error surfaces as a failed turn.
      await this.runOnePrompt(this.options.prompt, this.options.images);

      // Stay alive across turns; sendPrompt() reuses this connection.
      await this.awaitShutdown();
    } catch (err: unknown) {
      this.flushPendingThought();
      if (!this.isAborted) {
        const errorMessage = this.extractErrorMessage(err);
        // If we failed before newSession returned, emitInit was never called —
        // give the result a placeholder id so the message handler doesn't
        // choke on a null session.
        const resultSessionId = this.activeSessionId ?? randomUUID();
        if (!this.activeSessionId) {
          this.emitInit(
            resultSessionId,
            CODEX_BUILTIN_TOOLS,
            this.options.model ?? 'gpt-5.4',
            this.options.cwd,
          );
        }
        this.emitResult({
          sessionId: resultSessionId,
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
      throw new Error('CodexACPProcess: connection not initialized');
    }

    // Reset per-turn state.
    this.assistantMsgId = randomUUID();
    this.accumulatedText = '';
    this.toolCallsSeen.clear();
    this.lastAssistantText = '';
    this.pendingThought = null;

    const startTime = Date.now();

    // Forward images for this turn only if the agent advertised image support
    // — otherwise codex would reject the prompt or silently drop the blocks.
    const promptBlocks: Array<{ type: 'text'; text: string } | ACPImageBlock> = [
      { type: 'text', text: prompt },
    ];
    const imageBlocks = toACPImageBlocks(images);
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
      const promptResponse = await this.connection.prompt({
        sessionId: this.activeSessionId,
        prompt: promptBlocks,
      });

      // Usage / cost (rough GPT-5.4 class pricing)
      const usage = (promptResponse as any).usage as
        | { inputTokens?: number; outputTokens?: number }
        | undefined;
      if (usage) {
        const inputTokens = usage.inputTokens ?? 0;
        const outputTokens = usage.outputTokens ?? 0;
        this.totalCost += (inputTokens * 0.0025 + outputTokens * 0.01) / 1000;
      }
      this.emitAcpPromptResponseUsage(usage);

      this.numTurns += 1;

      const subtype: ResultSubtype =
        promptResponse.stopReason === 'end_turn'
          ? 'success'
          : promptResponse.stopReason === 'cancelled'
            ? 'error_during_execution'
            : promptResponse.stopReason === 'max_tokens' ||
                promptResponse.stopReason === 'max_turn_requests'
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

  // ── Permission request handling ────────────────────────────────

  private async handleRequestPermission(
    params: ACPRequestPermissionRequest,
  ): Promise<ACPRequestPermissionResponse> {
    const { options, toolCall } = params;

    const findOption = (kinds: string[]): string | undefined =>
      options.find((opt) => kinds.includes(opt.kind))?.optionId;

    const allowOptionId =
      findOption(['allow_once']) ?? findOption(['allow_always']) ?? options[0]?.optionId ?? '';
    const rejectOptionId =
      findOption(['reject_once']) ?? findOption(['reject_always']) ?? options[0]?.optionId ?? '';

    const acpKind = (toolCall.kind as string | undefined) ?? undefined;
    const title = toolCall.title ?? '';
    const toolName = inferACPToolName(acpKind, title);
    const toolInput = buildACPToolInput(toolName, {
      kind: acpKind,
      title,
      rawInput: toolCall.rawInput,
      locations: (toolCall as any).locations,
    });
    const toolInputForRule = serializeToolInputForRule(toolName, toolInput);

    // 1. Consult persisted rules (always allow / always deny) before pausing.
    if (this.options.permissionRuleLookup) {
      try {
        const match = await this.options.permissionRuleLookup({
          toolName,
          toolInput: toolInputForRule,
        });
        if (match?.decision === 'allow') {
          dlog.info('requestPermission ALLOW via persisted rule', { toolName });
          return { outcome: { outcome: 'selected', optionId: allowOptionId } };
        }
        if (match?.decision === 'deny') {
          dlog.info('requestPermission DENY via persisted rule', { toolName });
          return { outcome: { outcome: 'selected', optionId: rejectOptionId } };
        }
      } catch (err) {
        dlog.warn('permissionRuleLookup threw — falling through', {
          toolName,
          error: String(err).slice(0, 200),
        });
      }
    }

    // 2. No rule — emit a synthetic tool_use + tool_result so the runtime
    //    message handler matches the permission-denied regex and surfaces a
    //    PermissionApprovalCard. Then PAUSE until the run is aborted (the
    //    runner kills the process when the user approves and resumes with the
    //    new rule in place — same pattern as Claude SDK's preToolUseHook).
    const toolUseId = toolCall.toolCallId ?? randomUUID();
    const denialText =
      `Codex requested permissions to use ${toolName} but the user hasn't been granted approval. ` +
      `Waiting for user approval.`;

    this.emit('message', {
      type: 'assistant',
      message: {
        id: randomUUID(),
        content: [
          {
            type: 'tool_use',
            id: toolUseId,
            name: toolName,
            input: toolInput,
          },
        ],
      },
    } as CLIMessage);

    this.emit('message', {
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolUseId,
            content: denialText,
          },
        ],
      },
    } as CLIMessage);

    dlog.info('requestPermission PAUSING for user approval', {
      toolName,
      toolCallId: toolUseId,
    });

    return await new Promise<ACPRequestPermissionResponse>((resolve) => {
      const onAbort = () => {
        dlog.info('requestPermission RESUMED (abort signal)', { toolName });
        resolve({ outcome: { outcome: 'selected', optionId: rejectOptionId } });
      };
      if (this.abortController.signal.aborted) {
        onAbort();
      } else {
        this.abortController.signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  // ── Update translation (mirrors gemini-acp.translateUpdate) ───

  private translateUpdate(update: ACPSessionUpdate): void {
    if (this.handleAcpUsageUpdate(update)) return;

    switch (update.sessionUpdate) {
      case 'agent_thought_chunk': {
        // Buffer thought — flushed as a Think tool_call on the next non-thought event.
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

        // Codex sometimes emits "preamble" tool_calls whose title is just
        // `[current working directory …] (reason)` with no real input — they
        // narrate intent before the next real tool. Buffer them as Think text
        // so they render as a single collapsible Think card instead of a
        // stack of broken tool cards.
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

        // Rotate assistant message id so post-tool text becomes a separate DB message.
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

      default:
        return;
    }
  }

  // ── Binary resolution ───────────────────────────────────────

  private resolveCodexAcpCommand(): { command: string; args: string[] } {
    const explicit =
      process.env.CODEX_ACP_BINARY_PATH || process.env.ACP_CODEX_BIN || process.env.CODEX_BIN;
    if (explicit) return { command: explicit, args: [] };

    // Allow forcing the npx path for users who don't want a global install
    if (process.env.CODEX_ACP_USE_NPX === '1') {
      return { command: 'npx', args: ['-y', '@zed-industries/codex-acp'] };
    }

    // Default: rely on `codex-acp` in PATH (shell: true on Windows handles .cmd wrappers)
    return { command: 'codex-acp', args: [] };
  }
}

/**
 * Match the serialization Claude SDK uses for permission-rule lookup so a
 * single rule (e.g. "Bash: git status") behaves the same regardless of
 * provider. Bash gets the raw command; everything else gets stable JSON.
 */
function serializeToolInputForRule(
  toolName: string,
  toolInput: Record<string, unknown> | undefined,
): string | undefined {
  if (!toolInput || typeof toolInput !== 'object') return undefined;
  if (toolName === 'Bash' && typeof toolInput.command === 'string') {
    return toolInput.command;
  }
  try {
    return JSON.stringify(toolInput);
  } catch {
    return undefined;
  }
}
