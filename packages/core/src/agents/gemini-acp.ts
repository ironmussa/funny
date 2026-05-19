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
import { promises as fsp } from 'fs';
import { homedir } from 'os';
import path from 'path';
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

  /**
   * Rolling buffer of recent stderr from the gemini-cli child. Captured so
   * that when `connection.prompt()` rejects with a terse error from Gemini
   * (e.g. "Request contains an invalid argument."), the surrounding stderr
   * context — which often includes the malformed request body or a Google
   * SDK stack trace — is preserved for diagnosis.
   */
  private stderrTail = '';
  private static readonly STDERR_TAIL_MAX = 32 * 1024;

  private appendStderrTail(chunk: string): void {
    this.stderrTail += chunk;
    const max = GeminiACPProcess.STDERR_TAIL_MAX;
    if (this.stderrTail.length > max) {
      this.stderrTail = this.stderrTail.slice(this.stderrTail.length - max);
    }
  }

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

    // Diagnostics: when FUNNY_GEMINI_VERBOSE=1, pass --debug to gemini-cli
    // and set DEBUG=* so the Google Gen AI SDK logs the request/response
    // bodies it exchanges with Gemini. Output is captured by the existing
    // stderr tail buffer and dumped in `acp-timing: prompt-error`.
    const geminiVerbose = process.env.FUNNY_GEMINI_VERBOSE === '1';
    if (geminiVerbose) {
      args.push('--debug');
    }

    // autoEdit mode (full bypass, equivalent to Claude's `bypassPermissions`)
    // ⇒ run gemini with `--yolo` so it auto-approves everything without ever
    // invoking requestPermission. NOTE: this is funny's `autoEdit` mode, NOT
    // the Claude-only `auto` mode (which is filtered out client-side and
    // never reaches Gemini). gemini-cli silently downgrades --yolo to default
    // when the folder is not trusted, so we mark cwd TRUST_FOLDER first.
    const bypassMode = isAutoEditMode(this.options.originalPermissionMode);
    if (bypassMode) {
      await ensureTrustedFolder(this.options.cwd);
      args.push('--yolo');
      dlog.info('acp-timing: autoEdit (yolo) enabled', { ms: t(), cwd: this.options.cwd });
    }

    // Spawn gemini subprocess with stdio pipes.
    // On Windows, shell: true is required to resolve .cmd/.bat wrappers
    // for npm-installed binaries like `gemini`.
    const child = spawn(geminiBin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: this.options.cwd,
      env: {
        ...process.env,
        ...(geminiVerbose ? { DEBUG: '*' } : {}),
        ...this.options.env,
      },
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
      const raw = data.toString();
      this.appendStderrTail(raw);
      const trimmed = raw.trim();
      if (!trimmed) return;
      const errorText = this.parseStderrError(trimmed);
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
        return this.handleRequestPermission(params);
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
      const errAny = err as Record<string, unknown> | null;
      let errSerialized: string;
      try {
        errSerialized = JSON.stringify(err, Object.getOwnPropertyNames((err as object) ?? {}));
      } catch {
        errSerialized = String(err);
      }
      dlog.error('acp-timing: prompt-error', {
        sessionId: this.activeSessionId,
        turn: this.numTurns + 1,
        durationMs: Date.now() - startTime,
        aborted: this.isAborted,
        hadAssistantText: !!this.lastAssistantText,
        message: err instanceof Error ? err.message : String(err),
        errName: errAny?.name ?? null,
        errCode: errAny?.code ?? null,
        errData: errAny?.data ?? null,
        errCause: errAny?.cause ?? null,
        errStack: err instanceof Error ? err.stack : null,
        errSerialized,
        stderrTailBytes: this.stderrTail.length,
        stderrTail: this.stderrTail,
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

  // ── Permission request handling ─────────────────────────────

  /**
   * Handle an ACP `session/request_permission` from gemini-cli.
   *
   * Mirrors the codex-acp.ts pattern so the existing UI (PermissionApprovalCard)
   * and persisted "always allow / always deny" rules light up unchanged:
   *
   * 1. Consult `permissionRuleLookup` for a saved rule → auto-resolve.
   * 2. Otherwise emit a synthetic `tool_use` + `tool_result` whose denial text
   *    matches the regex in `agent-message-handler.ts` so the client renders
   *    the approval card. Then PAUSE on `abortController.signal` until the
   *    runner kills the process (user approves and the new rule takes effect
   *    on the next run).
   *
   * In auto mode (--yolo) gemini-cli auto-approves internally and never calls
   * requestPermission, so this handler is a no-op there.
   */
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

    // 1. Consult persisted rules (always allow / always deny).
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

    // 2. No rule — surface a permission request to the user via a synthetic
    //    tool_use + tool_result. Matches the regex in agent-message-handler.ts
    //    that drives PermissionApprovalCard.
    const toolUseId = toolCall.toolCallId ?? randomUUID();
    const denialText =
      `Gemini requested permissions to use ${toolName} but the user hasn't been granted approval. ` +
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

// ── Helpers ─────────────────────────────────────────────────────

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

/**
 * Detect funny's `autoEdit` mode — full permission bypass, equivalent to
 * Claude's `bypassPermissions`. In this mode we run gemini with `--yolo` so
 * it never pauses on `requestPermission`.
 *
 * NOTE: distinct from funny's `auto` mode (Claude-only; auto-accept low-risk
 * ops but still prompt for risky writes). `auto` is filtered client-side and
 * never reaches Gemini, so we don't handle it here.
 */
function isAutoEditMode(originalPermissionMode: string | undefined): boolean {
  return originalPermissionMode === 'autoEdit';
}

/**
 * Ensure the given cwd is marked TRUST_FOLDER in `~/.gemini/trustedFolders.json`.
 *
 * Required because gemini-cli silently downgrades `--yolo` → default approval
 * when the cwd is not trusted (`gemini-OHH6WLHR.js:8367`). It also blocks
 * runtime elevation to autoEdit with "Cannot enable privileged approval modes
 * in an untrusted folder."
 *
 * Best-effort: errors are logged and swallowed so a transient FS issue does
 * not block agent startup. Honors `GEMINI_CLI_TRUSTED_FOLDERS_PATH` if set
 * (matches gemini-cli's own override).
 */
async function ensureTrustedFolder(cwd: string): Promise<void> {
  const trustedPath =
    process.env.GEMINI_CLI_TRUSTED_FOLDERS_PATH ??
    path.join(homedir(), '.gemini', 'trustedFolders.json');

  try {
    let config: Record<string, string> = {};
    try {
      const raw = await fsp.readFile(trustedPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        config = parsed as Record<string, string>;
      }
    } catch (err: any) {
      if (err?.code !== 'ENOENT') {
        dlog.warn('trustedFolders.json read failed', { error: String(err).slice(0, 200) });
      }
    }

    if (config[cwd] === 'TRUST_FOLDER' || config[cwd] === 'TRUST_PARENT') {
      return; // already trusted
    }

    config[cwd] = 'TRUST_FOLDER';
    await fsp.mkdir(path.dirname(trustedPath), { recursive: true });
    await fsp.writeFile(trustedPath, JSON.stringify(config, null, 2), { mode: 0o600 });
    dlog.info('marked folder as TRUST_FOLDER for gemini yolo mode', { cwd, trustedPath });
  } catch (err) {
    dlog.warn('ensureTrustedFolder failed', { cwd, error: String(err).slice(0, 200) });
  }
}
